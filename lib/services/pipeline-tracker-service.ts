/**
 * PipelineTrackerService
 *
 * Read-only aggregator that correlates ingest, transcription, and upload jobs
 * for the same asset into unified pipeline entries. Broadcasts via the
 * `/pipeline` Socket.io namespace. Delegates retries/cancellations to the
 * underlying queue services.
 */

import type { Server as SocketIOServer } from 'socket.io';
import type { ProjectStore } from '@/lib/store/project-store';
import type { IngestJob } from '@/lib/services/ingest-queue-service';
import type { IngestQueueService } from '@/lib/services/ingest-queue-service';
import type { UploadJob } from '@/lib/services/upload-queue-service';
import type { UploadQueueService } from '@/lib/services/upload-queue-service';
import type { TranscriptJob } from '@/lib/services/transcripter-service';
import type { TranscripterService } from '@/lib/services/transcripter-service';
import type { PromotionJob } from '@/lib/services/promotion-queue-service';
import type { PromotionQueueService } from '@/lib/services/promotion-queue-service';
import { patchAsset } from '@/lib/store/media-registry';
import { triggerFrameIOUpload } from '@/lib/services/frameio-upload';
import { triggerLeaderPassPublish } from '@/lib/services/leaderpass-publish';
import type {
  PipelineEntry,
  PipelineOverallStatus,
  PipelineStage,
  PipelineStageType,
} from '@/lib/types/pipeline';
import { STAGE_TERMINAL_STATUSES } from '@/lib/types/pipeline';

// ── Stall thresholds per stage type (ms) ─────────────────────────────────────

const STALL_THRESHOLDS: Record<PipelineStageType, number> = {
  'ingest':             2 * 60_000,
  'transcript':         5 * 60_000,
  'upload:frameio':     2 * 60_000,
  'upload:leaderpass':  2 * 60_000,
  'promotion':          5 * 60_000,
};
const PROCESSING_STALL_MS    = 10 * 60_000;
const HARD_TIMEOUT_MULT      = 2;      // auto-fail at 2x stall threshold
const PURGE_AFTER_MS         = 30 * 60_000;
const TICK_INTERVAL_MS       = 10_000;
const PURGE_INTERVAL_MS      = 60_000;
const ORPHAN_MAX_RETRIES     = 3;      // sync cycles before creating standalone pipeline

// ── Helpers ──────────────────────────────────────────────────────────────────

function isStageTerminal(status: string): boolean {
  return STAGE_TERMINAL_STATUSES.has(status);
}

function computeOverall(stages: PipelineStage[]): PipelineOverallStatus {
  if (stages.length === 0) return 'ingesting';

  const active = stages.filter((s) => !isStageTerminal(s.status));
  if (active.length > 0) {
    // Return the highest-priority active stage label
    for (const type of ['ingest', 'transcript', 'upload:frameio', 'upload:leaderpass', 'promotion'] as PipelineStageType[]) {
      const match = active.find((s) => s.type === type);
      if (match) {
        if (type === 'ingest') return 'ingesting';
        if (type === 'transcript') return 'transcribing';
        if (type === 'upload:frameio') {
          return match.status === 'processing' ? 'processing' : 'uploading_frameio';
        }
        if (type === 'upload:leaderpass') {
          return match.status === 'processing' ? 'processing' : 'uploading_leaderpass';
        }
        if (type === 'promotion') return 'processing';
      }
    }
    return 'ingesting';
  }

  // All stages terminal
  const hasFailure = stages.some((s) => s.status === 'failed');
  const hasDone = stages.some((s) => s.status === 'done');
  const allCancelled = stages.every((s) => s.status === 'cancelled' || s.status === 'canceled');

  if (allCancelled) return 'cancelled';
  if (hasFailure && hasDone) return 'partial_failure';
  if (hasFailure) return 'failed';
  return 'complete';
}

// ── Service ──────────────────────────────────────────────────────────────────

export class PipelineTrackerService {
  // Keyed by pipelineId (first jobId for an asset's lifecycle)
  private pipelines = new Map<string, PipelineEntry>();
  // assetId → pipelineId lookup (set once assetId is known)
  private assetIndex = new Map<string, string>();
  // jobId → pipelineId lookup
  private jobIndex = new Map<string, string>();
  // Jobs waiting for their asset's pipeline to appear (race condition buffer)
  private pendingOrphans = new Map<string, {
    jobs: Array<{ job: UploadJob | TranscriptJob; type: 'upload' | 'transcript' }>;
    retries: number;
  }>();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  private ingestService: IngestQueueService | null = null;
  private uploadService: UploadQueueService | null = null;
  private transcriptService: TranscripterService | null = null;
  private promotionService: PromotionQueueService | null = null;

  constructor(
    private io: SocketIOServer,
    private projectStore: ProjectStore,
  ) {}

  subscribe(
    ingest: IngestQueueService,
    upload: UploadQueueService,
    transcript: TranscripterService,
    promotion?: PromotionQueueService,
  ): void {
    this.ingestService = ingest;
    this.uploadService = upload;
    this.transcriptService = transcript;
    this.promotionService = promotion ?? null;

    ingest.onQueueChange((jobs) => this.syncIngest(jobs));
    upload.onQueueChange((jobs) => this.syncUpload(jobs));
    transcript.onQueueChange((jobs) => this.syncTranscript(jobs));
    promotion?.onQueueChange((jobs) => this.syncPromotion(jobs));
  }

  start(): void {
    this.io.of('/pipeline').on('connection', (socket) => {
      socket.emit('pipelines', this.getEntries());
      socket.on('retry', (data: { pipelineId: string; stageType: PipelineStageType }) => {
        this.handleRetry(data.pipelineId, data.stageType);
      });
      socket.on('cancel', (data: { pipelineId: string; stageType: PipelineStageType }) => {
        this.handleCancel(data.pipelineId, data.stageType);
      });
      socket.on('clearFailed', () => {
        this.clearFailed();
      });
      socket.on('clearCancelled', () => {
        this.clearCancelled();
      });
    });

    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
    console.log('[pipeline-tracker] service running');
  }

  stop(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.purgeTimer) { clearInterval(this.purgeTimer); this.purgeTimer = null; }
  }

  getEntries(): PipelineEntry[] {
    return Array.from(this.pipelines.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Build a projectId → name map in O(n) once instead of scanning per job. */
  private buildProjectMap(): Map<string, string> {
    return new Map(this.projectStore.getAll().map((p) => [p.projectId, p.name]));
  }

  // ── Sync handlers ────────────────────────────────────────────────────────

  private syncIngest(jobs: IngestJob[]): void {
    const projectMap = this.buildProjectMap();
    let changed = false;
    for (const job of jobs) {
      const existing = this.jobIndex.get(job.jobId);
      if (existing) {
        // Update existing stage
        const entry = this.pipelines.get(existing);
        if (entry) {
          const stage = entry.stages.find((s) => s.jobId === job.jobId);
          if (stage) {
            Object.assign(stage, this.ingestToStage(job));
          }
          // Capture assetId once it becomes available
          if (job.assetId && !entry.assetId) {
            entry.assetId = job.assetId;
            this.assetIndex.set(job.assetId, entry.pipelineId);
          }
          this.refreshEntry(entry);
          changed = true;
        }
      } else {
        // Don't create new pipeline entries for already-terminal jobs
        // (e.g. old completed jobs still in SQLite after tracker purge)
        if (isStageTerminal(job.status)) continue;

        // New ingest job → new pipeline entry
        const projectName = projectMap.get(job.projectId) ?? job.projectId;
        const entry: PipelineEntry = {
          pipelineId: job.jobId,
          assetId: job.assetId || null,
          projectId: job.projectId,
          projectName,
          filename: job.filename,
          overallStatus: 'ingesting',
          stages: [this.ingestToStage(job)],
          createdAt: job.queuedAt,
          updatedAt: job.updatedAt,
        };
        this.pipelines.set(entry.pipelineId, entry);
        this.jobIndex.set(job.jobId, entry.pipelineId);
        if (job.assetId) this.assetIndex.set(job.assetId, entry.pipelineId);
        this.refreshEntry(entry);
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }

  private syncUpload(jobs: UploadJob[]): void {
    const projectMap = this.buildProjectMap();
    let changed = false;
    for (const job of jobs) {
      const existingByJob = this.jobIndex.get(job.jobId);
      if (existingByJob) {
        const entry = this.pipelines.get(existingByJob);
        if (entry) {
          const stage = entry.stages.find((s) => s.jobId === job.jobId);
          if (stage) Object.assign(stage, this.uploadToStage(job));
          this.refreshEntry(entry);
          changed = true;
        }
        continue;
      }

      // Try to attach to existing pipeline by assetId
      const pipelineId = this.assetIndex.get(job.assetId);
      if (pipelineId) {
        const entry = this.pipelines.get(pipelineId);
        if (entry) {
          const stageType: PipelineStageType = job.provider === 'leaderpass' ? 'upload:leaderpass' : 'upload:frameio';
          // Don't add duplicate stage type for same job
          if (!entry.stages.some((s) => s.jobId === job.jobId)) {
            entry.stages.push(this.uploadToStage(job));
          }
          this.jobIndex.set(job.jobId, pipelineId);
          this.refreshEntry(entry);
          changed = true;
          continue;
        }
      }

      // Don't create new pipeline entries for already-terminal jobs
      if (isStageTerminal(job.status)) continue;

      // Defer orphan: wait for the ingest pipeline to register this assetId
      if (job.assetId) {
        this.addPendingOrphan(job.assetId, job, 'upload');
        continue;
      }

      // No assetId at all — create standalone pipeline
      const projectName = projectMap.get(job.projectId) ?? job.projectId;
      const entry: PipelineEntry = {
        pipelineId: job.jobId,
        assetId: job.assetId || null,
        projectId: job.projectId,
        projectName,
        filename: job.filename,
        overallStatus: 'uploading_frameio',
        stages: [this.uploadToStage(job)],
        createdAt: job.queuedAt,
        updatedAt: job.updatedAt,
      };
      this.pipelines.set(entry.pipelineId, entry);
      this.jobIndex.set(job.jobId, entry.pipelineId);
      this.refreshEntry(entry);
      changed = true;
    }
    changed = this.resolvePendingOrphans() || changed;
    if (changed) this.broadcast();
  }

  private syncPromotion(jobs: PromotionJob[]): void {
    const projectMap = this.buildProjectMap();
    let changed = false;
    for (const job of jobs) {
      const existing = this.jobIndex.get(job.jobId);
      if (existing) {
        const entry = this.pipelines.get(existing);
        if (entry) {
          const stage = entry.stages.find((s) => s.jobId === job.jobId);
          if (stage) Object.assign(stage, this.promotionToStage(job));
          this.refreshEntry(entry);
          changed = true;
        }
      } else {
        // Don't create entries for already-terminal jobs arriving after a purge
        if (isStageTerminal(job.status)) continue;

        // Promotion jobs are always standalone — no assetId to correlate with
        const projectName = projectMap.get(job.projectId) ?? job.projectId;
        const entry: PipelineEntry = {
          pipelineId:    job.jobId,
          assetId:       null,
          projectId:     job.projectId,
          projectName,
          filename:      job.filename,
          overallStatus: 'processing',
          stages:        [this.promotionToStage(job)],
          createdAt:     job.queuedAt,
          updatedAt:     job.updatedAt,
        };
        this.pipelines.set(entry.pipelineId, entry);
        this.jobIndex.set(job.jobId, entry.pipelineId);
        this.refreshEntry(entry);
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }

  private syncTranscript(jobs: TranscriptJob[]): void {
    const projectMap = this.buildProjectMap();
    let changed = false;
    for (const job of jobs) {
      const existingByJob = this.jobIndex.get(job.jobId);
      if (existingByJob) {
        const entry = this.pipelines.get(existingByJob);
        if (entry) {
          const stage = entry.stages.find((s) => s.jobId === job.jobId);
          if (stage) Object.assign(stage, this.transcriptToStage(job));
          this.refreshEntry(entry);
          changed = true;
        }
        continue;
      }

      // Try to attach to existing pipeline by assetId
      const pipelineId = this.assetIndex.get(job.assetId);
      if (pipelineId) {
        const entry = this.pipelines.get(pipelineId);
        if (entry) {
          if (!entry.stages.some((s) => s.jobId === job.jobId)) {
            entry.stages.push(this.transcriptToStage(job));
          }
          this.jobIndex.set(job.jobId, pipelineId);
          this.refreshEntry(entry);
          changed = true;
          continue;
        }
      }

      // Don't create new pipeline entries for already-terminal jobs
      if (isStageTerminal(job.status)) continue;

      // Defer orphan: wait for the ingest pipeline to register this assetId
      if (job.assetId) {
        this.addPendingOrphan(job.assetId, job, 'transcript');
        continue;
      }

      // No assetId at all — create standalone pipeline
      const projectName = projectMap.get(job.projectId) ?? job.projectId;
      const entry: PipelineEntry = {
        pipelineId: job.jobId,
        assetId: job.assetId || null,
        projectId: job.projectId,
        projectName,
        filename: job.filename,
        overallStatus: 'transcribing',
        stages: [this.transcriptToStage(job)],
        createdAt: job.queuedAt,
        updatedAt: job.updatedAt,
      };
      this.pipelines.set(entry.pipelineId, entry);
      this.jobIndex.set(job.jobId, entry.pipelineId);
      this.refreshEntry(entry);
      changed = true;
    }
    changed = this.resolvePendingOrphans() || changed;
    if (changed) this.broadcast();
  }

  // ── Stage mappers ────────────────────────────────────────────────────────

  private ingestToStage(job: IngestJob): PipelineStage {
    return {
      type: 'ingest',
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      error: job.error,
      detail: job.detail,
      queuedAt: job.queuedAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      stalled: false,
    };
  }

  private uploadToStage(job: UploadJob): PipelineStage {
    return {
      type: job.provider === 'leaderpass' ? 'upload:leaderpass' : 'upload:frameio',
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      error: job.error,
      detail: job.detail,
      queuedAt: job.queuedAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      stalled: false,
    };
  }

  private transcriptToStage(job: TranscriptJob): PipelineStage {
    return {
      type: 'transcript',
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      error: job.error,
      queuedAt: job.queuedAt,
      updatedAt: job.updatedAt,
      stalled: false,
    };
  }

  private promotionToStage(job: PromotionJob): PipelineStage {
    return {
      type:        'promotion',
      jobId:       job.jobId,
      status:      job.status,
      progress:    job.progress,
      error:       job.error,
      detail:      job.detail,
      queuedAt:    job.queuedAt,
      updatedAt:   job.updatedAt,
      completedAt: job.completedAt,
      stalled:     false,
    };
  }

  // ── Entry refresh ────────────────────────────────────────────────────────

  private refreshEntry(entry: PipelineEntry): void {
    entry.overallStatus = computeOverall(entry.stages);
    entry.updatedAt = new Date().toISOString();
    const allTerminal = entry.stages.length > 0 && entry.stages.every((s) => isStageTerminal(s.status));
    if (allTerminal && !entry.completedAt) {
      entry.completedAt = new Date().toISOString();
    } else if (!allTerminal) {
      entry.completedAt = undefined;
    }
  }

  // ── Tick (stall detection) ───────────────────────────────────────────────

  private tick(): void {
    const now = Date.now();
    let changed = false;
    for (const entry of this.pipelines.values()) {
      for (const stage of entry.stages) {
        if (isStageTerminal(stage.status)) {
          if (stage.stalled) { stage.stalled = false; changed = true; }
          continue;
        }

        // Queued stages are waiting their turn — never flag them as stalled or
        // auto-fail them. Stall/timeout only applies once a stage has started.
        if (stage.status === 'queued') {
          if (stage.stalled) { stage.stalled = false; changed = true; }
          continue;
        }

        const elapsed = now - Date.parse(stage.updatedAt);
        const threshold = stage.status === 'processing' ? PROCESSING_STALL_MS : STALL_THRESHOLDS[stage.type];
        const stalled = elapsed >= threshold;
        if (stage.stalled !== stalled) {
          stage.stalled = stalled;
          changed = true;
        }

        // Auto-fail at 2x stall threshold — safety net for truly stuck jobs
        if (elapsed >= threshold * HARD_TIMEOUT_MULT) {
          const reason = 'Auto-failed: exceeded maximum allowed time';
          switch (stage.type) {
            case 'ingest':
              this.ingestService?.fail(stage.jobId, reason);
              break;
            case 'upload:frameio':
            case 'upload:leaderpass':
              this.uploadService?.fail(stage.jobId, reason);
              break;
            case 'transcript':
              this.transcriptService?.failJob(stage.jobId, reason);
              break;
            case 'promotion':
              this.promotionService?.fail(stage.jobId, reason);
              break;
          }
          // The service's fail() triggers onQueueChange → sync, which will update
          // the stage status on the next cycle. No need to modify stage here.
        }
      }
    }
    if (changed) this.broadcast();
  }

  // ── Clear failed / cancelled ──────────────────────────────────────────────

  /** Remove all terminal-failed pipeline entries from the in-memory view and broadcast. */
  clearFailed(): void {
    let changed = false;
    for (const [id, entry] of this.pipelines) {
      if (entry.overallStatus === 'failed' || entry.overallStatus === 'partial_failure') {
        for (const stage of entry.stages) this.jobIndex.delete(stage.jobId);
        if (entry.assetId) this.assetIndex.delete(entry.assetId);
        this.pipelines.delete(id);
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }

  /** Remove all cancelled pipeline entries from the in-memory view and broadcast. */
  clearCancelled(): void {
    let changed = false;
    for (const [id, entry] of this.pipelines) {
      if (entry.overallStatus === 'cancelled') {
        for (const stage of entry.stages) this.jobIndex.delete(stage.jobId);
        if (entry.assetId) this.assetIndex.delete(entry.assetId);
        this.pipelines.delete(id);
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }

  // ── Purge ────────────────────────────────────────────────────────────────

  private purge(): void {
    const cutoff = Date.now() - PURGE_AFTER_MS;
    let changed = false;
    for (const [id, entry] of this.pipelines) {
      if (entry.completedAt && Date.parse(entry.completedAt) < cutoff) {
        // Clean up indices
        for (const stage of entry.stages) this.jobIndex.delete(stage.jobId);
        if (entry.assetId) this.assetIndex.delete(entry.assetId);
        this.pipelines.delete(id);
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }

  // ── Retry ────────────────────────────────────────────────────────────────

  private handleRetry(pipelineId: string, stageType: PipelineStageType): void {
    const entry = this.pipelines.get(pipelineId);
    if (!entry) return;
    const stage = entry.stages.find((s) => s.type === stageType && s.status === 'failed');
    if (!stage) return;
    // Non-promotion retries require an assetId to re-trigger the underlying service
    if (stageType !== 'promotion' && !entry.assetId) return;

    switch (stageType) {
      case 'upload:frameio':
        patchAsset(entry.projectId, entry.assetId!, { frameio: { status: 'none', lastError: null } });
        triggerFrameIOUpload(entry.projectId, entry.assetId!);
        break;
      case 'upload:leaderpass':
        patchAsset(entry.projectId, entry.assetId!, {
          leaderpass: { status: 'none', lastError: null },
          cloudflare: { status: 'none', progress: 0, lastError: null },
        });
        triggerLeaderPassPublish(entry.projectId, entry.assetId!);
        break;
      case 'transcript': {
        const txJobs = this.transcriptService?.getQueue() ?? [];
        const txJob = txJobs.find((j) => j.jobId === stage.jobId);
        if (txJob && this.transcriptService) {
          patchAsset(entry.projectId, entry.assetId!, {
            transcription: { status: 'queued', jobId: null, completedAt: null },
          });
          this.transcriptService.enqueue(entry.projectId, txJob.sourcePath, entry.assetId!, entry.filename);
        }
        break;
      }
      case 'promotion': {
        const failedJob = this.promotionService?.getJob(stage.jobId);
        if (failedJob && this.promotionService) {
          // Drop the failed stage and re-queue the file as a new job
          entry.stages = entry.stages.filter((s) => s.jobId !== stage.jobId);
          this.jobIndex.delete(stage.jobId);
          const newJobId = this.promotionService.add(
            failedJob.projectId,
            failedJob.filename,
            failedJob.fileKey,
            failedJob.mimeType,
            failedJob.fileSize,
            failedJob.destination,
          );
          const newJob = this.promotionService.getJob(newJobId);
          if (newJob) {
            entry.stages.push(this.promotionToStage(newJob));
            this.jobIndex.set(newJobId, entry.pipelineId);
          }
          this.refreshEntry(entry);
          this.broadcast();
        }
        break;
      }
      // 'ingest' — not retryable
    }
  }

  // ── Cancel ───────────────────────────────────────────────────────────────

  private handleCancel(pipelineId: string, stageType: PipelineStageType): void {
    const entry = this.pipelines.get(pipelineId);
    if (!entry) return;
    const stage = entry.stages.find((s) => s.type === stageType && !isStageTerminal(s.status));
    if (!stage) return;

    switch (stageType) {
      case 'ingest':
        this.ingestService?.cancel(stage.jobId);
        break;
      case 'upload:frameio':
      case 'upload:leaderpass':
        this.uploadService?.cancel(stage.jobId);
        break;
      case 'promotion':
        this.promotionService?.cancel(stage.jobId);
        break;
      // transcript cancellation handled by the transcripter's socket listener
    }
  }

  // ── Pending orphan resolution ───────────────────────────────────────────

  private addPendingOrphan(assetId: string, job: UploadJob | TranscriptJob, type: 'upload' | 'transcript'): void {
    const existing = this.pendingOrphans.get(assetId);
    if (existing) {
      // Don't add duplicate jobs
      if (!existing.jobs.some((j) => j.job.jobId === job.jobId)) {
        existing.jobs.push({ job, type });
      }
    } else {
      this.pendingOrphans.set(assetId, { jobs: [{ job, type }], retries: 0 });
    }
  }

  /** Try to attach pending orphans to pipelines. Returns true if any were resolved. */
  private resolvePendingOrphans(): boolean {
    const projectMap = this.buildProjectMap();
    let changed = false;
    for (const [assetId, pending] of this.pendingOrphans) {
      const pipelineId = this.assetIndex.get(assetId);
      if (pipelineId) {
        const entry = this.pipelines.get(pipelineId);
        if (entry) {
          for (const { job } of pending.jobs) {
            if (!entry.stages.some((s) => s.jobId === job.jobId)) {
              const stage = 'provider' in job ? this.uploadToStage(job as UploadJob) : this.transcriptToStage(job as TranscriptJob);
              entry.stages.push(stage);
            }
            this.jobIndex.set(job.jobId, pipelineId);
          }
          this.refreshEntry(entry);
          changed = true;
        }
        this.pendingOrphans.delete(assetId);
        continue;
      }

      pending.retries++;
      if (pending.retries > ORPHAN_MAX_RETRIES) {
        // Create standalone pipelines for each job
        for (const { job, type } of pending.jobs) {
          if (this.jobIndex.has(job.jobId)) continue;
          const projectName = projectMap.get(job.projectId) ?? job.projectId;
          const stage = type === 'upload' ? this.uploadToStage(job as UploadJob) : this.transcriptToStage(job as TranscriptJob);
          const entry: PipelineEntry = {
            pipelineId: job.jobId,
            assetId: assetId || null,
            projectId: job.projectId,
            projectName,
            filename: job.filename,
            overallStatus: type === 'upload' ? 'uploading_frameio' : 'transcribing',
            stages: [stage],
            createdAt: job.queuedAt,
            updatedAt: job.updatedAt,
          };
          this.pipelines.set(entry.pipelineId, entry);
          this.jobIndex.set(job.jobId, entry.pipelineId);
          if (assetId) this.assetIndex.set(assetId, entry.pipelineId);
          this.refreshEntry(entry);
          changed = true;
        }
        this.pendingOrphans.delete(assetId);
      }
    }
    return changed;
  }

  // ── Broadcast ────────────────────────────────────────────────────────────

  private broadcast(): void {
    this.io.of('/pipeline').emit('pipelines', this.getEntries());
  }
}
