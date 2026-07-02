import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Server as SocketIOServer } from 'socket.io';
import { recordActivity, serviceActor } from '@/lib/services/activity-monitor-service';
import type { ServiceRegistry } from './registry';
import { MediaProcessor, type ProcessorPhase } from './media-processor';
import {
  getTranscriptionWorkers,
  getTranscriptionTimeoutMs,
} from './transcription-config';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

export type TranscriptJobStatus =
  | 'queued'
  | 'extracting_audio'
  | 'transcribing'
  | 'writing_outputs'
  | 'done'
  | 'failed'
  | 'canceled';

/**
 * Why a transcription job was enqueued.
 *   - `standard`      — the normal LPOS transcript that backs the Transcripts UI.
 *                       Writes the `.meta.json` sidecar and prunes older transcripts
 *                       for the asset, and drives `asset.transcription.*` state.
 *   - `lpai_sidecar`  — an ADDITIVE high-quality (large-v3-turbo) pass produced only
 *                       at LP.AI provision time. It must NOT write `.meta.json`, must
 *                       NOT prune the standard transcript, and must NOT touch
 *                       `asset.transcription.*`. Its `<jobId>.words.json` / `<jobId>.json`
 *                       are read directly by the caller via the completion callback.
 */
export type TranscriptJobPurpose = 'standard' | 'lpai_sidecar';

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
  /** Optional source media duration (seconds); feeds the length-aware timeout. */
  durationSec?: number;
  /**
   * Per-job whisper model override (bare name, e.g. "large-v3-turbo"). When unset
   * the MediaProcessor resolves from admin Settings → env → "base". Used by the
   * LP.AI turbo-on-provision path to force a high-quality pass without changing
   * the global default that normal ingest uses.
   */
  model?: string;
  /** Why this job exists. Defaults to 'standard'. See TranscriptJobPurpose. */
  purpose: TranscriptJobPurpose;
  queuedAt: string;
  updatedAt: string;
}

/** Options for the LP.AI turbo sidecar enqueue path. */
export interface EnqueueSidecarOptions {
  model?: string;
  durationSec?: number;
  displayName?: string;
}

type JobCompleteCallback = (job: TranscriptJob) => void;

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

  /**
   * Register a callback that fires when any job reaches a terminal state.
   * Returns an unregister function so short-lived listeners (e.g. the LP.AI
   * turbo-job waiter) don't accumulate on the callback list.
   */
  onJobComplete(cb: JobCompleteCallback): () => void {
    this.completionCallbacks.push(cb);
    return () => {
      const i = this.completionCallbacks.indexOf(cb);
      if (i >= 0) this.completionCallbacks.splice(i, 1);
    };
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

  enqueue(projectId: string, filePath: string, assetId: string, displayName?: string, durationSec?: number): TranscriptJob {
    const job: TranscriptJob = {
      jobId:      randomUUID(),
      assetId,
      projectId,
      filename:   displayName ?? path.basename(filePath),
      sourcePath: filePath,
      status:     'queued',
      progress:   0,
      durationSec: (typeof durationSec === 'number' && durationSec > 0) ? durationSec : undefined,
      purpose:    'standard',
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

    if (this.activeProcessors.size < getTranscriptionWorkers()) setImmediate(() => this.processNext());

    console.log(`[transcripter] enqueued "${job.filename}" (${job.jobId})`);
    return job;
  }

  /**
   * Enqueue an ADDITIVE high-quality sidecar transcription for LP.AI provisioning.
   *
   * Differs from `enqueue` in three deliberate ways so the standard Transcripts-UI
   * transcript is never disturbed:
   *   1. `purpose = 'lpai_sidecar'` — processNext skips the `.meta.json` write, the
   *      prune-old-transcripts pass, and never patches `asset.transcription.*`.
   *   2. carries a `model` override (normally `large-v3-turbo`) so this pass is
   *      high quality regardless of the global model the base ingest used.
   *   3. its outputs land at a fresh `<jobId>.*` prefix (new UUID), so they cannot
   *      collide with the base transcript's files.
   *
   * The caller reads the resulting `<jobId>.words.json` / `<jobId>.json` via an
   * `onJobComplete` callback filtered on the returned jobId.
   */
  enqueueSidecar(projectId: string, filePath: string, assetId: string, opts: EnqueueSidecarOptions = {}): TranscriptJob {
    const job: TranscriptJob = {
      jobId:      randomUUID(),
      assetId,
      projectId,
      filename:   opts.displayName ?? path.basename(filePath),
      sourcePath: filePath,
      status:     'queued',
      progress:   0,
      durationSec: (typeof opts.durationSec === 'number' && opts.durationSec > 0) ? opts.durationSec : undefined,
      model:      opts.model,
      purpose:    'lpai_sidecar',
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
      // Operator-only: this is a background quality pass for LP.AI, not something
      // the user needs surfaced on their timeline alongside the real transcript.
      visibility: 'operator_only',
      title: `LP.AI turbo transcript queued: ${job.filename}`,
      summary: `${job.filename} was queued for a ${opts.model ?? 'high-quality'} LP.AI transcript`,
      project_id: projectId,
      asset_id: assetId,
      job_id: job.jobId,
      source_service: 'transcripter',
      details_json: { filename: job.filename, sourcePath: filePath, model: opts.model, purpose: 'lpai_sidecar' },
    });

    if (this.activeProcessors.size < getTranscriptionWorkers()) setImmediate(() => this.processNext());

    console.log(`[transcripter] enqueued LP.AI sidecar "${job.filename}" (${job.jobId}, model=${opts.model ?? 'default'})`);
    return job;
  }

  getQueue(): TranscriptJob[] {
    return Array.from(this.jobs.values());
  }

  /** True if a worker is currently executing this job. Used by pipeline tracker
   *  to veto auto-fail when the underlying worker is still alive. */
  isJobActive(jobId: string): boolean {
    return this.activeProcessors.has(jobId);
  }

  /** Bump updatedAt without changing status — resets stall clock when a caller
   *  (pipeline tracker) has confirmed the underlying work is still alive. */
  heartbeat(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') return;
    job.updatedAt = new Date().toISOString();
    this.broadcast();
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
    if (!next || this.activeProcessors.size >= getTranscriptionWorkers()) return;

    const isSidecar = next.purpose === 'lpai_sidecar';
    this.updateJob(next.jobId, { status: 'extracting_audio', progress: 5 });
    recordActivity({
      ...serviceActor('Transcripter', 'transcripter'),
      occurred_at: new Date().toISOString(),
      event_type: 'transcription.started',
      lifecycle_phase: 'running',
      source_kind: 'background_service',
      // Sidecar (LP.AI turbo) passes stay operator-only so they don't duplicate the
      // user-facing transcription timeline for the same asset.
      visibility: isSidecar ? 'operator_only' : 'user_timeline',
      title: isSidecar ? `LP.AI turbo transcript started: ${next.filename}` : `Transcription started: ${next.filename}`,
      summary: isSidecar ? `${next.filename} started a ${next.model ?? 'high-quality'} LP.AI transcript` : `${next.filename} started transcription`,
      project_id: next.projectId,
      asset_id: next.assetId,
      job_id: next.jobId,
      source_service: 'transcripter',
      details_json: { filename: next.filename, sourcePath: next.sourcePath, purpose: next.purpose, model: next.model },
    });

    const projectDir = path.join(DATA_DIR, 'projects', next.projectId);
    const processor  = new MediaProcessor();
    this.activeProcessors.set(next.jobId, processor);

    processor.on('progress', ({ phase, percent }: { phase: ProcessorPhase; percent: number }) => {
      this.updateJob(next.jobId, { status: phase as TranscriptJobStatus, progress: percent });
    });

    // Length-aware (or fixed-floor) timeout resolved live from admin Settings.
    // Big models (large-v3*) on long videos routinely exceed the old fixed 15-min
    // cap, so enabling length-aware mode scales the budget with media duration.
    const timeoutMs = getTranscriptionTimeoutMs(next.durationSec);

    let processingTimeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        processingTimeout = setTimeout(() => {
          processor.abort();
          reject(new Error(`Transcription timed out after ${Math.round(timeoutMs / 60_000)} minutes`));
        }, timeoutMs);
      });
      const result = await Promise.race([
        processor.process({
          jobId:      next.jobId,
          filePath:   next.sourcePath,
          projectDir,
          // Per-job override (LP.AI turbo sidecar). Undefined for standard jobs, in
          // which case MediaProcessor resolves the global Settings/env/base model.
          model:      next.model,
        }),
        timeoutPromise,
      ]);

      if (processingTimeout) clearTimeout(processingTimeout);
      this.updateJob(next.jobId, {
        status:      'done',
        progress:    100,
        outputFiles: [result.txtPath, result.srtPath, result.vttPath, result.jsonPath, result.wordsPath]
          .filter(Boolean) as string[],
      });

      if (next.purpose === 'standard') {
        // Write sidecar so the Transcripts tab can show the original filename
        try {
          const metaPath = path.join(projectDir, 'transcripts', `${next.jobId}.meta.json`);
          const meta = {
            jobId:       next.jobId,
            assetId:     next.assetId,
            filename:    next.filename,
            completedAt: new Date().toISOString(),
          };
          await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
        } catch (e) {
          console.warn('[transcripter] could not write transcript meta:', e);
        }

        // Remove any older transcript files for the same asset now that this job succeeded.
        // Fire-and-forget — pruning is best-effort cleanup and shouldn't block the queue.
        void this.pruneOldTranscripts(next.projectId, next.assetId, next.jobId);
      } else {
        // LP.AI turbo sidecar: keep ONLY the machine-readable transcripts the LP.AI
        // push consumes (`.json` + `.words.json`). Drop the human-facing outputs so
        // this pass never appears as a second, unnamed entry in the Transcripts UI
        // (which enumerates `.txt` files). No `.meta.json` is written and the
        // standard transcript is never pruned — the base transcript is untouched.
        void this.cleanupSidecarUiFiles(next.projectId, next.jobId);
      }

      this.fireCompletion(next.jobId);
      recordActivity({
        ...serviceActor('Transcripter', 'transcripter'),
        occurred_at: new Date().toISOString(),
        event_type: 'transcription.completed',
        lifecycle_phase: 'completed',
        source_kind: 'background_service',
        visibility: isSidecar ? 'operator_only' : 'user_timeline',
        title: isSidecar ? `LP.AI turbo transcript completed: ${next.filename}` : `Transcription completed: ${next.filename}`,
        summary: isSidecar ? `${next.filename} finished its ${next.model ?? 'high-quality'} LP.AI transcript` : `${next.filename} finished transcription`,
        project_id: next.projectId,
        asset_id: next.assetId,
        job_id: next.jobId,
        source_service: 'transcripter',
        details_json: {
          filename: next.filename,
          purpose: next.purpose,
          model: next.model,
          outputFiles: [result.txtPath, result.srtPath, result.vttPath, result.jsonPath, result.wordsPath].filter(Boolean),
        },
      });
      console.log(`[transcripter] ✓ completed "${next.filename}"`);

    } catch (err) {
      if (processingTimeout) clearTimeout(processingTimeout);
      const msg = (err as Error).message;
      // If cancelJob already marked this job as canceled, don't overwrite it with failed.
      if (this.jobs.get(next.jobId)?.status === 'canceled') return;
      this.updateJob(next.jobId, { status: 'failed', error: msg });
      console.error(`[transcripter] ✗ failed "${next.filename}":`, msg);
      this.fireCompletion(next.jobId);
      recordActivity({
        ...serviceActor('Transcripter', 'transcripter'),
        occurred_at: new Date().toISOString(),
        event_type: 'transcription.failed',
        lifecycle_phase: 'failed',
        source_kind: 'background_service',
        visibility: isSidecar ? 'operator_only' : 'user_timeline',
        title: isSidecar ? `LP.AI turbo transcript failed: ${next.filename}` : `Transcription failed: ${next.filename}`,
        summary: isSidecar ? `${next.filename} failed its LP.AI transcript pass` : `${next.filename} failed during transcription`,
        project_id: next.projectId,
        asset_id: next.assetId,
        job_id: next.jobId,
        source_service: 'transcripter',
        details_json: { filename: next.filename, error: msg, purpose: next.purpose, model: next.model },
      });

    } finally {
      this.activeProcessors.delete(next.jobId);
      const hasMore = Array.from(this.jobs.values()).some((j) => j.status === 'queued');
      if (hasMore) setImmediate(() => this.processNext());
    }
  }

  /**
   * Cancel all active or queued transcription jobs for a given asset.
   * Also deletes any partial output files the job may have written.
   * Call this when an asset is deleted while transcription is in progress.
   */
  cancelByAsset(assetId: string): void {
    for (const job of this.jobs.values()) {
      if (
        job.assetId === assetId &&
        job.status !== 'done' &&
        job.status !== 'failed' &&
        job.status !== 'canceled'
      ) {
        this.cancelJob(job.jobId);
        this.cleanupJobFiles(job.projectId, job.jobId);
      }
    }
  }

  private cleanupJobFiles(projectId: string, jobId: string): void {
    const transcriptsDir = path.join(DATA_DIR, 'projects', projectId, 'transcripts');
    const subtitlesDir   = path.join(DATA_DIR, 'projects', projectId, 'subtitles');
    for (const name of [`${jobId}.txt`, `${jobId}.json`, `${jobId}.words.json`, `${jobId}.meta.json`]) {
      try { fs.unlinkSync(path.join(transcriptsDir, name)); } catch { /* already gone */ }
    }
    for (const name of [`${jobId}.srt`, `${jobId}.vtt`]) {
      try { fs.unlinkSync(path.join(subtitlesDir, name)); } catch { /* already gone */ }
    }
    console.log(`[transcripter] cleaned up partial files for cancelled job ${jobId}`);
  }

  /**
   * Drop only the human-facing outputs of an LP.AI sidecar job (`.txt`, `.srt`,
   * `.vtt`), keeping `<jobId>.json` + `<jobId>.words.json` for the LP.AI push.
   * Removing the `.txt` keeps this pass out of the `.txt`-keyed Transcripts UI
   * enumeration. Best-effort; failures are logged and swallowed.
   */
  private async cleanupSidecarUiFiles(projectId: string, jobId: string): Promise<void> {
    const transcriptsDir = path.join(DATA_DIR, 'projects', projectId, 'transcripts');
    const subtitlesDir   = path.join(DATA_DIR, 'projects', projectId, 'subtitles');
    for (const name of [`${jobId}.txt`]) {
      try { await fs.promises.unlink(path.join(transcriptsDir, name)); } catch { /* already gone */ }
    }
    for (const name of [`${jobId}.srt`, `${jobId}.vtt`]) {
      try { await fs.promises.unlink(path.join(subtitlesDir, name)); } catch { /* already gone */ }
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

  private async pruneOldTranscripts(projectId: string, assetId: string, keepJobId: string): Promise<void> {
    const transcriptsDir = path.join(DATA_DIR, 'projects', projectId, 'transcripts');
    const subtitlesDir   = path.join(DATA_DIR, 'projects', projectId, 'subtitles');

    try {
      const allFiles = await fs.promises.readdir(transcriptsDir);
      const metaFiles = allFiles.filter((f) => f.endsWith('.meta.json'));
      for (const metaFile of metaFiles) {
        const oldJobId = metaFile.replace('.meta.json', '');
        if (oldJobId === keepJobId) continue;

        try {
          const raw = await fs.promises.readFile(path.join(transcriptsDir, metaFile), 'utf8');
          const meta = JSON.parse(raw) as { assetId?: string };
          if (meta.assetId !== assetId) continue;
        } catch {
          continue;
        }

        for (const name of [`${oldJobId}.txt`, `${oldJobId}.json`, `${oldJobId}.words.json`, `${oldJobId}.meta.json`]) {
          try { await fs.promises.unlink(path.join(transcriptsDir, name)); } catch { /* already gone */ }
        }
        for (const name of [`${oldJobId}.srt`, `${oldJobId}.vtt`]) {
          try { await fs.promises.unlink(path.join(subtitlesDir, name)); } catch { /* already gone */ }
        }
        console.log(`[transcripter] pruned old transcript ${oldJobId} for asset ${assetId}`);
      }
    } catch {
      // transcripts dir may not exist yet — ignore
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
