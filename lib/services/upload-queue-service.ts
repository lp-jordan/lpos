import { randomUUID } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';
import {
  recordUploadJobStart,
  sweepStaleUploadJobs,
  updateUploadJobStatus,
} from '@/lib/store/job-record-store';

const UPLOAD_TIMEOUT_MS = 3 * 60_000; // 3 minutes without progress → auto-fail
const TIMEOUT_SWEEP_MS  = 30_000;     // check every 30s
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

export type UploadJobStatus = 'queued' | 'compressing' | 'uploading' | 'processing' | 'done' | 'failed' | 'cancelled';
export type UploadJobProvider = 'frameio' | 'leaderpass' | 'sardius' | 'delivery';

export interface UploadJob {
  jobId: string;
  assetId: string;
  projectId: string;
  filename: string;
  provider: UploadJobProvider;
  status: UploadJobStatus;
  progress: number;
  error?: string;
  detail?: string;
  queuedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export class UploadQueueService {
  private jobs = new Map<string, UploadJob>();
  private cancelledIds = new Set<string>();
  private changeListeners: Array<(jobs: UploadJob[]) => void> = [];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private io: SocketIOServer) {}

  onQueueChange(cb: (jobs: UploadJob[]) => void): void {
    this.changeListeners.push(cb);
  }

  start(): void {
    const attach = (namespace: string) => {
      this.io.of(namespace).on('connection', (socket) => {
        socket.emit('queue', this.getQueue());
        socket.on('cancel', (jobId: string) => this.cancel(jobId));
      });
    };

    attach('/upload-queue');
    attach('/frameio-uploads');
    this.sweepTimer = setInterval(() => this.timeoutSweep(), TIMEOUT_SWEEP_MS);

    const swept = sweepStaleUploadJobs();
    console.log(`[UploadQueue] swept ${swept} stale jobs`);
  }

  stop(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  add(projectId: string, assetId: string, filename: string, provider: UploadJobProvider = 'frameio'): string {
    const jobId = randomUUID();
    const queuedAt = new Date().toISOString();
    this.jobs.set(jobId, {
      jobId,
      assetId,
      projectId,
      filename,
      provider,
      status: 'queued',
      progress: 0,
      queuedAt,
      updatedAt: queuedAt,
    });
    recordUploadJobStart({ jobId, projectId, assetId, filename, provider, queuedAt });
    this.broadcast();
    return jobId;
  }

  setCompressing(jobId: string, progress: number, detail?: string): void {
    this.patch(jobId, { status: 'compressing', progress, detail, error: undefined });
  }

  setProgress(jobId: string, progress: number, detail?: string): void {
    this.patch(jobId, { status: 'uploading', progress, detail, error: undefined });
  }

  setProcessing(jobId: string, detail: string): void {
    this.patch(jobId, { status: 'processing', progress: 100, detail, error: undefined });
  }

  complete(jobId: string): void {
    const completedAt = new Date().toISOString();
    this.patch(jobId, { status: 'done', progress: 100, detail: undefined, error: undefined, completedAt });
    updateUploadJobStatus(jobId, 'done', completedAt);
  }

  fail(jobId: string, error: string): void {
    this.patch(jobId, { status: 'failed', error, detail: undefined, completedAt: new Date().toISOString() });
    updateUploadJobStatus(jobId, 'failed');
  }

  cancel(jobId: string): void {
    this.cancelledIds.add(jobId);
    this.patch(jobId, { status: 'cancelled', detail: undefined, error: undefined, completedAt: new Date().toISOString() });
    updateUploadJobStatus(jobId, 'cancelled');
  }

  isCancelled(jobId: string): boolean {
    return this.cancelledIds.has(jobId);
  }

  getQueue(): UploadJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  }

  private patch(jobId: string, update: Partial<UploadJob>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, update, { updatedAt: new Date().toISOString() });
    this.broadcast();
  }

  private broadcast(): void {
    const queue = this.getQueue();
    this.io.of('/upload-queue').emit('queue', queue);
    this.io.of('/frameio-uploads').emit('queue', queue);
    this.changeListeners.forEach((cb) => cb(queue));
  }

  private timeoutSweep(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (TERMINAL_STATUSES.has(job.status)) continue;
      if (now - Date.parse(job.updatedAt) > UPLOAD_TIMEOUT_MS) {
        console.warn(`[upload-queue] auto-failing stale job ${job.jobId} (${job.filename})`);
        this.fail(job.jobId, 'Timed out: no progress received');
      }
    }
  }
}
