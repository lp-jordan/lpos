/**
 * PromotionQueueService
 *
 * In-memory queue for client asset promotion jobs — transferring files from
 * the ingest R2 bucket into either Google Drive (docs/images) or local
 * storage (video). Follows the same pattern as UploadQueueService.
 */

import { randomUUID } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PromotionStatus =
  | 'queued'
  | 'downloading'
  | 'promoting'
  | 'done'
  | 'failed'
  | 'cancelled';

export type PromotionDestination = 'assets' | 'scripts';
export type PromotionStorageType = 'drive' | 'local';

export interface PromotionJob {
  jobId:        string;
  projectId:    string;
  filename:     string;
  fileKey:      string;       // R2 object key in ingest bucket
  mimeType:     string;
  fileSize:     number;
  destination:  PromotionDestination;
  storageType:  PromotionStorageType; // drive or local (videos)
  status:       PromotionStatus;
  progress:     number;
  error?:       string;
  detail?:      string;
  entityId?:    string;       // drive_assets entityId once promoted
  queuedAt:     string;
  updatedAt:    string;
  completedAt?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class PromotionQueueService {
  private jobs = new Map<string, PromotionJob>();
  private changeListeners: Array<(jobs: PromotionJob[]) => void> = [];

  constructor(private io: SocketIOServer | undefined) {}

  start(): void {
    this.io?.of('/promotion-queue').on('connection', (socket) => {
      socket.emit('queue', this.getQueue());
    });
    console.log('[promotion-queue] service running');
  }

  stop(): void { /* no-op — in-memory */ }

  onQueueChange(cb: (jobs: PromotionJob[]) => void): void {
    this.changeListeners.push(cb);
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  add(
    projectId:   string,
    filename:    string,
    fileKey:     string,
    mimeType:    string,
    fileSize:    number,
    destination: PromotionDestination,
  ): string {
    const jobId    = randomUUID();
    const now      = new Date().toISOString();
    const isVideo  = mimeType.startsWith('video/');
    const storageType: PromotionStorageType = isVideo ? 'local' : 'drive';

    this.jobs.set(jobId, {
      jobId,
      projectId,
      filename,
      fileKey,
      mimeType,
      fileSize,
      destination,
      storageType,
      status:    'queued',
      progress:  0,
      queuedAt:  now,
      updatedAt: now,
    });

    this.broadcast();
    return jobId;
  }

  setDownloading(jobId: string, progress: number): void {
    this.patch(jobId, { status: 'downloading', progress, detail: `Downloading ${progress}%` });
  }

  setPromoting(jobId: string, progress: number): void {
    this.patch(jobId, { status: 'promoting', progress, detail: `Transferring ${progress}%` });
  }

  complete(jobId: string, entityId: string): void {
    const now = new Date().toISOString();
    this.patch(jobId, { status: 'done', progress: 100, detail: undefined, error: undefined, entityId, completedAt: now });
  }

  fail(jobId: string, error: string): void {
    const now = new Date().toISOString();
    this.patch(jobId, { status: 'failed', error, detail: undefined, completedAt: now });
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'done' || job.status === 'failed') return;
    const now = new Date().toISOString();
    this.patch(jobId, { status: 'cancelled', detail: undefined, error: undefined, completedAt: now });
  }

  getQueue(): PromotionJob[] {
    return [...this.jobs.values()].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  }

  getJob(jobId: string): PromotionJob | undefined {
    return this.jobs.get(jobId);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private patch(jobId: string, update: Partial<PromotionJob>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, update, { updatedAt: new Date().toISOString() });
    this.broadcast();
  }

  private broadcast(): void {
    this.io?.of('/promotion-queue').emit('queue', this.getQueue());
    for (const cb of this.changeListeners) cb(this.getQueue());
  }
}
