import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Server as SocketIOServer } from 'socket.io';
import { recordActivity, serviceActor } from '@/lib/services/activity-monitor-service';
import type { ServiceRegistry } from './registry';
import { MediaProcessor, type ProcessorPhase } from './media-processor';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const TRANSCRIPT_TIMEOUT_MS = 15 * 60_000; // 15 minutes max per job

export type TranscriptJobStatus =
  | 'queued'
  | 'extracting_audio'
  | 'transcribing'
  | 'writing_outputs'
  | 'done'
  | 'failed'
  | 'canceled';

export interface TranscriptJob {
  jobId: string;
  assetId: string;
  projectId: string;
  filename: string;
  sourcePath: string;
  status: TranscriptJobStatus;
  progress: number;
  error?: string;
  outputFiles?: string[];
  queuedAt: string;
  updatedAt: string;
}

type JobCompleteCallback = (job: TranscriptJob) => void;

// Maximum concurrent whisper.cpp workers. Default 2; override with LPOS_TRANSCRIPTION_WORKERS.
const MAX_WORKERS = Math.max(1, parseInt(process.env.LPOS_TRANSCRIPTION_WORKERS ?? '2', 10));

export class TranscripterService {
  private jobs = new Map<string, TranscriptJob>();
  // Map of jobId → active MediaProcessor (one entry per running worker)
  private activeProcessors = new Map<string, MediaProcessor>();
  private completionCallbacks: JobCompleteCallback[] = [];
  private changeListeners: Array<(jobs: TranscriptJob[]) => void> = [];

  constructor(
    private io: SocketIOServer,
    private registry: ServiceRegistry,
  ) {}

  /** Register a callback that fires when any job reaches a terminal state. */
  onJobComplete(cb: JobCompleteCallback): void {
    this.completionCallbacks.push(cb);
  }

  onQueueChange(cb: (jobs: TranscriptJob[]) => void): void {
    this.changeListeners.push(cb);
  }

  async start(): Promise<void> {
    this.registry.register('transcripter', 'Transcripter');

    this.io.of('/transcripter').on('connection', (socket) => {
      socket.emit('queue', this.getQueue());
      socket.on('job:cancel', (jobId: string) => this.cancelJob(jobId));
    });

    this.registry.update('transcripter', 'running');
    console.log('[transcripter] service running');
  }

  async stop(): Promise<void> {
    this.activeProcessors.forEach((p) => p.abort());
    this.registry.update('transcripter', 'stopped');
  }

  // ── Public API (called by upload route) ──────────────────────────────────

  enqueue(projectId: string, filePath: string, assetId: string, displayName?: string): TranscriptJob {
    const job: TranscriptJob = {
      jobId:      randomUUID(),
      assetId,
      projectId,
      filename:   displayName ?? path.basename(filePath),
      sourcePath: filePath,
      status:     'queued',
      progress:   0,
      queuedAt:   new Date().toISOString(),
      updatedAt:  new Date().toISOString(),
    };

    this.jobs.set(job.jobId, job);
    this.broadcast();
    recordActivity({
      ...serviceActor('Transcripter', 'transcripter'),
      occurred_at: job.queuedAt,
      event_type: 'transcription.queued',
      lifecycle_phase: 'queued',
      source_kind: 'background_service',
      visibility: 'user_timeline',
      title: `Transcription queued: ${job.filename}`,
      summary: `${job.filename} was queued for transcription`,
      project_id: projectId,
      asset_id: assetId,
      job_id: job.jobId,
      source_service: 'transcripter',
      details_json: { filename: job.filename, sourcePath: filePath },
    });

    if (this.activeProcessors.size < MAX_WORKERS) setImmediate(() => this.processNext());

    console.log(`[transcripter] enqueued "${job.filename}" (${job.jobId})`);
    return job;
  }

  getQueue(): TranscriptJob[] {
    return Array.from(this.jobs.values());
  }

  /** Externally mark a job as failed (used by pipeline tracker auto-fail). */
  failJob(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'done' || job.status === 'failed' || job.status === 'canceled') return;
    this.activeProcessors.get(jobId)?.abort();
    this.updateJob(jobId, { status: 'failed', error });
    this.fireCompletion(jobId);
    console.warn(`[transcripter] externally failed "${job.filename}": ${error}`);
  }

  // ── Queue runner ─────────────────────────────────────────────────────────

  private async processNext(): Promise<void> {
    const next = Array.from(this.jobs.values()).find((j) => j.status === 'queued');
    if (!next || this.activeProcessors.size >= MAX_WORKERS) return;

    this.updateJob(next.jobId, { status: 'extracting_audio', progress: 5 });
    recordActivity({
      ...serviceActor('Transcripter', 'transcripter'),
      occurred_at: new Date().toISOString(),
      event_type: 'transcription.started',
      lifecycle_phase: 'running',
      source_kind: 'background_service',
      visibility: 'user_timeline',
      title: `Transcription started: ${next.filename}`,
      summary: `${next.filename} started transcription`,
      project_id: next.projectId,
      asset_id: next.assetId,
      job_id: next.jobId,
      source_service: 'transcripter',
      details_json: { filename: next.filename, sourcePath: next.sourcePath },
    });

    const projectDir = path.join(DATA_DIR, 'projects', next.projectId);
    const processor  = new MediaProcessor();
    this.activeProcessors.set(next.jobId, processor);

    processor.on('progress', ({ phase, percent }: { phase: ProcessorPhase; percent: number }) => {
      this.updateJob(next.jobId, { status: phase as TranscriptJobStatus, progress: percent });
    });

    let processingTimeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        processingTimeout = setTimeout(() => {
          processor.abort();
          reject(new Error(`Transcription timed out after ${TRANSCRIPT_TIMEOUT_MS / 60_000} minutes`));
        }, TRANSCRIPT_TIMEOUT_MS);
      });
      const result = await Promise.race([
        processor.process({
          jobId:      next.jobId,
          filePath:   next.sourcePath,
          projectDir,
        }),
        timeoutPromise,
      ]);

      if (processingTimeout) clearTimeout(processingTimeout);
      this.updateJob(next.jobId, {
        status:      'done',
        progress:    100,
        outputFiles: [result.txtPath, result.srtPath, result.vttPath, result.jsonPath]
          .filter(Boolean) as string[],
      });

      // Write sidecar so the Transcripts tab can show the original filename
      try {
        const metaPath = path.join(projectDir, 'transcripts', `${next.jobId}.meta.json`);
        const meta = {
          jobId:       next.jobId,
          assetId:     next.assetId,
          filename:    next.filename,
          completedAt: new Date().toISOString(),
        };
        (await import('node:fs')).writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      } catch (e) {
        console.warn('[transcripter] could not write transcript meta:', e);
      }

      this.fireCompletion(next.jobId);
      recordActivity({
        ...serviceActor('Transcripter', 'transcripter'),
        occurred_at: new Date().toISOString(),
        event_type: 'transcription.completed',
        lifecycle_phase: 'completed',
        source_kind: 'background_service',
        visibility: 'user_timeline',
        title: `Transcription completed: ${next.filename}`,
        summary: `${next.filename} finished transcription`,
        project_id: next.projectId,
        asset_id: next.assetId,
        job_id: next.jobId,
        source_service: 'transcripter',
        details_json: {
          filename: next.filename,
          outputFiles: [result.txtPath, result.srtPath, result.vttPath, result.jsonPath].filter(Boolean),
        },
      });
      console.log(`[transcripter] ✓ completed "${next.filename}"`);

    } catch (err) {
      if (processingTimeout) clearTimeout(processingTimeout);
      const msg = (err as Error).message;
      this.updateJob(next.jobId, { status: 'failed', error: msg });
      console.error(`[transcripter] ✗ failed "${next.filename}":`, msg);
      this.fireCompletion(next.jobId);
      recordActivity({
        ...serviceActor('Transcripter', 'transcripter'),
        occurred_at: new Date().toISOString(),
        event_type: 'transcription.failed',
        lifecycle_phase: 'failed',
        source_kind: 'background_service',
        visibility: 'user_timeline',
        title: `Transcription failed: ${next.filename}`,
        summary: `${next.filename} failed during transcription`,
        project_id: next.projectId,
        asset_id: next.assetId,
        job_id: next.jobId,
        source_service: 'transcripter',
        details_json: { filename: next.filename, error: msg },
      });

    } finally {
      this.activeProcessors.delete(next.jobId);
      const hasMore = Array.from(this.jobs.values()).some((j) => j.status === 'queued');
      if (hasMore) setImmediate(() => this.processNext());
    }
  }

  private cancelJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.status === 'queued') {
      this.updateJob(jobId, { status: 'canceled' });
      recordActivity({
        ...serviceActor('Transcripter', 'transcripter'),
        occurred_at: new Date().toISOString(),
        event_type: 'transcription.cancelled',
        lifecycle_phase: 'cancelled',
        source_kind: 'background_service',
        visibility: 'operator_only',
        title: `Transcription cancelled: ${job.filename}`,
        summary: `${job.filename} transcription was cancelled`,
        project_id: job.projectId,
        asset_id: job.assetId,
        job_id: job.jobId,
        source_service: 'transcripter',
        details_json: { filename: job.filename },
      });
    } else if (job.status !== 'done' && job.status !== 'failed') {
      this.activeProcessors.get(jobId)?.abort();
      this.updateJob(jobId, { status: 'canceled' });
      recordActivity({
        ...serviceActor('Transcripter', 'transcripter'),
        occurred_at: new Date().toISOString(),
        event_type: 'transcription.cancelled',
        lifecycle_phase: 'cancelled',
        source_kind: 'background_service',
        visibility: 'operator_only',
        title: `Transcription cancelled: ${job.filename}`,
        summary: `${job.filename} transcription was cancelled`,
        project_id: job.projectId,
        asset_id: job.assetId,
        job_id: job.jobId,
        source_service: 'transcripter',
        details_json: { filename: job.filename },
      });
    }
  }

  private updateJob(jobId: string, patch: Partial<TranscriptJob>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.broadcast();
  }

  private broadcast(): void {
    const queue = this.getQueue();
    this.io.of('/transcripter').emit('queue', queue);
    this.changeListeners.forEach((cb) => cb(queue));
  }

  private fireCompletion(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.completionCallbacks.forEach((cb) => { try { cb(job); } catch { /* ignore */ } });
  }
}
