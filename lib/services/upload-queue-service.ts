import { randomUUID } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';

export type UploadJobStatus = 'queued' | 'compressing' | 'uploading' | 'done' | 'failed' | 'cancelled';
export type UploadJobProvider = 'frameio' | 'leaderpass';

export interface UploadJob {
  jobId: string;
  assetId: string;
  projectId: string;
  filename: string;
  provider: UploadJobProvider;
  status: UploadJobStatus;
  progress: number;
  error?: string;
  queuedAt: string;
  completedAt?: string;
}

export class UploadQueueService {
  private jobs = new Map<string, UploadJob>();
  private cancelledIds = new Set<string>();

  constructor(private io: SocketIOServer) {}

  start(): void {
    const attach = (namespace: string) => {
      this.io.of(namespace).on('connection', (socket) => {
        socket.emit('queue', this.getQueue());
        socket.on('cancel', (jobId: string) => this.cancel(jobId));
      });
    };

    attach('/upload-queue');
    attach('/frameio-uploads');
  }

  add(projectId: string, assetId: string, filename: string, provider: UploadJobProvider = 'frameio'): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, {
      jobId,
      assetId,
      projectId,
      filename,
      provider,
      status: 'queued',
      progress: 0,
      queuedAt: new Date().toISOString(),
    });
    this.broadcast();
    return jobId;
  }

  setCompressing(jobId: string, progress: number): void {
    this.patch(jobId, { status: 'compressing', progress });
  }

  setProgress(jobId: string, progress: number): void {
    this.patch(jobId, { status: 'uploading', progress });
  }

  complete(jobId: string): void {
    this.patch(jobId, { status: 'done', progress: 100, completedAt: new Date().toISOString() });
  }

  fail(jobId: string, error: string): void {
    this.patch(jobId, { status: 'failed', error, completedAt: new Date().toISOString() });
  }

  cancel(jobId: string): void {
    this.cancelledIds.add(jobId);
    this.patch(jobId, { status: 'cancelled', completedAt: new Date().toISOString() });
  }

  isCancelled(jobId: string): boolean {
    return this.cancelledIds.has(jobId);
  }

  getQueue(): UploadJob[] {
    return Array.from(this.jobs.values());
  }

  private patch(jobId: string, update: Partial<UploadJob>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, update);
    this.broadcast();
  }

  private broadcast(): void {
    const queue = this.getQueue();
    this.io.of('/upload-queue').emit('queue', queue);
    this.io.of('/frameio-uploads').emit('queue', queue);
  }
}
