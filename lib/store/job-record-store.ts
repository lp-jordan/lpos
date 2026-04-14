/**
 * Job Record Store
 *
 * Lightweight SQLite persistence for upload and promotion jobs.
 * Written on job start, updated on terminal transition, and swept to
 * 'interrupted' on server boot. Lives in lpos-ingest-queue.sqlite alongside
 * ingest_jobs and upload_sessions.
 */

import { getIngestQueueDb } from './ingest-queue-db';

// ── Upload jobs ───────────────────────────────────────────────────────────────

export interface UploadJobRecord {
  jobId:       string;
  projectId:   string;
  assetId:     string;
  filename:    string;
  provider:    string;
  status:      string;
  queuedAt:    string;
  updatedAt:   string;
  completedAt?: string;
}

export function recordUploadJobStart(job: {
  jobId:     string;
  projectId: string;
  assetId:   string;
  filename:  string;
  provider:  string;
  queuedAt:  string;
}): void {
  const db  = getIngestQueueDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO upload_job_records
      (job_id, project_id, asset_id, filename, provider, status, queued_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)
  `).run(job.jobId, job.projectId, job.assetId, job.filename, job.provider, job.queuedAt, now);
}

export function updateUploadJobStatus(
  jobId:       string,
  status:      'done' | 'failed' | 'cancelled',
  completedAt?: string,
): void {
  const db  = getIngestQueueDb();
  const now = new Date().toISOString();
  const completed = completedAt ?? now;
  db.prepare(`
    UPDATE upload_job_records
    SET status = ?, updated_at = ?, completed_at = ?
    WHERE job_id = ?
  `).run(status, now, completed, jobId);
}

/** Marks all in_progress upload records as interrupted. Returns the count swept. */
export function sweepStaleUploadJobs(): number {
  const db  = getIngestQueueDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE upload_job_records
    SET status = 'interrupted', updated_at = ?
    WHERE status = 'in_progress'
  `).run(now);
  return result.changes as number;
}

// ── Promotion jobs ────────────────────────────────────────────────────────────

export interface PromotionJobRecord {
  jobId:       string;
  projectId:   string;
  filename:    string;
  fileKey:     string;
  destination: string;
  storageType: string;
  status:      string;
  queuedAt:    string;
  updatedAt:   string;
  completedAt?: string;
}

export function recordPromotionJobStart(job: {
  jobId:       string;
  projectId:   string;
  filename:    string;
  fileKey:     string;
  destination: string;
  storageType: string;
  queuedAt:    string;
}): void {
  const db  = getIngestQueueDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO promotion_job_records
      (job_id, project_id, filename, file_key, destination, storage_type, status, queued_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)
  `).run(
    job.jobId, job.projectId, job.filename, job.fileKey,
    job.destination, job.storageType, job.queuedAt, now,
  );
}

export function updatePromotionJobStatus(
  jobId:       string,
  status:      'done' | 'failed' | 'cancelled',
  completedAt?: string,
): void {
  const db  = getIngestQueueDb();
  const now = new Date().toISOString();
  const completed = completedAt ?? now;
  db.prepare(`
    UPDATE promotion_job_records
    SET status = ?, updated_at = ?, completed_at = ?
    WHERE job_id = ?
  `).run(status, now, completed, jobId);
}

/** Marks all in_progress promotion records as interrupted. Returns the count swept. */
export function sweepStalePromotionJobs(): number {
  const db  = getIngestQueueDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE promotion_job_records
    SET status = 'interrupted', updated_at = ?
    WHERE status = 'in_progress'
  `).run(now);
  return result.changes as number;
}
