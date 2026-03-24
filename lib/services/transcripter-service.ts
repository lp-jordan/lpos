import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Server as SocketIOServer } from 'socket.io';
import type { ServiceRegistry } from './registry';
import { MediaProcessor, type ProcessorPhase } from './media-processor';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

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
}

type JobCompleteCallback = (job: TranscriptJob) => void;

export class TranscripterService {
  private jobs = new Map<string, TranscriptJob>();
  private activeProcessor: MediaProcessor | null = null;
  private isProcessing = false;
  private completionCallbacks: JobCompleteCallback[] = [];

  constructor(
    private io: SocketIOServer,
    private registry: ServiceRegistry,
  ) {}

  /** Register a callback that fires when any job reaches a terminal state. */
  onJobComplete(cb: JobCompleteCallback): void {
    this.completionCallbacks.push(cb);
  }

  async start(): Promise<void> {
    this.registry.register('transcripter', 'Transcripter');

    this.io.of('/transcripter').on('connection', (socket) => {
      console.log('[transcripter] client connected:', socket.id);
      socket.emit('queue', this.getQueue());
      socket.on('job:cancel', (jobId: string) => this.cancelJob(jobId));
      socket.on('disconnect', () =>
        console.log('[transcripter] client disconnected:', socket.id)
      );
    });

    this.registry.update('transcripter', 'running');
    console.log('[transcripter] service running');
  }

  async stop(): Promise<void> {
    this.activeProcessor?.abort();
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
    };

    this.jobs.set(job.jobId, job);
    this.broadcast();

    if (!this.isProcessing) setImmediate(() => this.processNext());

    console.log(`[transcripter] enqueued "${job.filename}" (${job.jobId})`);
    return job;
  }

  getQueue(): TranscriptJob[] {
    return Array.from(this.jobs.values());
  }

  // ── Queue runner ─────────────────────────────────────────────────────────

  private async processNext(): Promise<void> {
    const next = Array.from(this.jobs.values()).find((j) => j.status === 'queued');
    if (!next || this.isProcessing) return;

    this.isProcessing = true;
    this.updateJob(next.jobId, { status: 'extracting_audio', progress: 5 });

    const projectDir = path.join(DATA_DIR, 'projects', next.projectId);
    const processor  = new MediaProcessor();
    this.activeProcessor = processor;

    processor.on('progress', ({ phase, percent }: { phase: ProcessorPhase; percent: number }) => {
      this.updateJob(next.jobId, { status: phase as TranscriptJobStatus, progress: percent });
    });

    try {
      const result = await processor.process({
        jobId:      next.jobId,
        filePath:   next.sourcePath,
        projectDir,
      });

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
      console.log(`[transcripter] ✓ completed "${next.filename}"`);

    } catch (err) {
      const msg = (err as Error).message;
      this.updateJob(next.jobId, { status: 'failed', error: msg });
      console.error(`[transcripter] ✗ failed "${next.filename}":`, msg);
      this.fireCompletion(next.jobId);

    } finally {
      this.isProcessing = false;
      this.activeProcessor = null;
      const hasMore = Array.from(this.jobs.values()).some((j) => j.status === 'queued');
      if (hasMore) setImmediate(() => this.processNext());
    }
  }

  private cancelJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.status === 'queued') {
      this.updateJob(jobId, { status: 'canceled' });
    } else if (this.isProcessing && job.status !== 'done' && job.status !== 'failed') {
      this.activeProcessor?.abort();
      this.updateJob(jobId, { status: 'canceled' });
    }
  }

  private updateJob(jobId: string, patch: Partial<TranscriptJob>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, patch);
    this.broadcast();
  }

  private broadcast(): void {
    this.io.of('/transcripter').emit('queue', this.getQueue());
  }

  private fireCompletion(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.completionCallbacks.forEach((cb) => { try { cb(job); } catch { /* ignore */ } });
  }
}
