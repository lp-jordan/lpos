/**
 * IngestQueueService
 *
 * Tracks media ingest jobs (browser → LPOS server) in memory and broadcasts
 * state to all connected clients via the `/media-ingest` Socket.io namespace.
 * Mirrors the pattern used by UploadQueueService (Frame.io uploads).
 */

import { randomUUID } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';

export type IngestJobStatus = 'queued' | 'ingesting' | 'done' | 'failed' | 'cancelled';

export interface IngestJob {
  jobId:        string;
  assetId:      string;   // populated after registration; '' while streaming
  projectId:    string;
  filename:     string;
  status:       IngestJobStatus;
  progress:     number;   // 0–100
  error?:       string;
  queuedAt:     string;   // ISO
  completedAt?: string;   // ISO — set on done/failed
}

export class IngestQueueService {
  private jobs         = new Map<string, IngestJob>();
  private cancelledIds = new Set<string>();

  constructor(private io: SocketIOServer) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    this.io.of('/media-ingest').on('connection', (socket) => {
      console.log('[ingest-queue] client connected:', socket.id);
      socket.emit('queue', this.getQueue());
      socket.on('cancel', (jobId: string) => this.cancel(jobId));
      socket.on('disconnect', () =>
        console.log('[ingest-queue] client disconnected:', socket.id)
      );
    });
    console.log('[ingest-queue] service running');
  }

  // ── Public API (called by media/route.ts) ─────────────────────────────────

  /** Register a new ingest job. Returns the jobId. */
  add(projectId: string, filename: string): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, {
      jobId,
      assetId:  '',
      projectId,
      filename,
      status:   'queued',
      progress: 0,
      queuedAt: new Date().toISOString(),
    });
    this.broadcast();
    return jobId;
  }

  /** Attach the real assetId once the file has been registered. */
  setAssetId(jobId: string, assetId: string): void {
    this.patch(jobId, { assetId });
  }

  /** Update progress (0-100) while streaming. */
  setProgress(jobId: string, progress: number): void {
    this.patch(jobId, { status: 'ingesting', progress });
  }

  /** Mark a job as successfully completed. */
  complete(jobId: string): void {
    this.patch(jobId, { status: 'done', progress: 100, completedAt: new Date().toISOString() });
  }

  /** Mark a job as failed with an error message. */
  fail(jobId: string, error: string): void {
    this.patch(jobId, { status: 'failed', error, completedAt: new Date().toISOString() });
  }

  /** Cancel a job — broadcasts immediately, route discards the file on finish. */
  cancel(jobId: string): void {
    this.cancelledIds.add(jobId);
    this.patch(jobId, { status: 'cancelled', completedAt: new Date().toISOString() });
  }

  /** Returns true if the job has been cancelled. */
  isCancelled(jobId: string): boolean {
    return this.cancelledIds.has(jobId);
  }

  getQueue(): IngestJob[] {
    return Array.from(this.jobs.values());
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private patch(jobId: string, update: Partial<IngestJob>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, update);
    this.broadcast();
  }

  private broadcast(): void {
    this.io.of('/media-ingest').emit('queue', this.getQueue());
  }
}
