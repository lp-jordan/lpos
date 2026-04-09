/**
 * IngestQueueService
 *
 * Tracks media ingest jobs (browser → LPOS server) persisted to SQLite and
 * broadcasts state to all connected clients via the `/media-ingest` Socket.io
 * namespace. On boot, detects interrupted ingests and cleans up orphaned files.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';
import { getIngestQueueDb } from '@/lib/store/ingest-queue-db';
import { recordActivity, serviceActor } from '@/lib/services/activity-monitor-service';

export type IngestJobStatus = 'queued' | 'ingesting' | 'done' | 'failed' | 'cancelled' | 'awaiting_confirmation';

export interface IngestJob {
  jobId:        string;
  assetId:      string;   // populated after registration; '' while streaming
  projectId:    string;
  filename:     string;
  status:       IngestJobStatus;
  progress:     number;   // 0–100
  error?:       string;
  queuedAt:     string;   // ISO
  detail?:      string;
  updatedAt:    string;   // ISO
  completedAt?: string;   // ISO — set on done/failed
  tempPath?:    string;   // upload-* temp file path
  stablePath?:  string;   // final assetId-based file path
  batchId?:     string;   // shared UUID for all jobs reserved together
  fileSize?:    number;   // bytes — set at reserve time for display in IngestTray
  // Chunked upload fields — populated for jobs using the chunked upload path
  uploadId?:    string;   // upload_sessions.upload_id, present for chunked jobs
  versionMeta?: {         // present when status = 'awaiting_confirmation'
    existingAsset:        unknown;
    currentVersionNumber: number;
  };
}

interface IngestJobRow {
  job_id: string;
  asset_id: string;
  project_id: string;
  filename: string;
  status: string;
  progress: number;
  error: string | null;
  detail: string | null;
  temp_path: string | null;
  stable_path: string | null;
  queued_at: string;
  updated_at: string;
  completed_at: string | null;
  batch_id: string | null;
  file_size: number | null;
}

const PURGE_AGE_MS = 7 * 24 * 60 * 60_000; // 7 days
// Pre-reserved jobs with no upload started are treated as abandoned after this
// period and auto-failed so they don't linger in the IngestTray indefinitely.
const STALE_QUEUED_AFTER_MS = 10 * 60_000; // 10 minutes
const STALE_SWEEP_INTERVAL_MS = 2 * 60_000; // sweep every 2 minutes
// Chunked upload sessions with no progress for this long are timed out.
const STALE_UPLOAD_SESSION_AFTER_MS = 60 * 60_000; // 1 hour
// awaiting_confirmation sessions auto-expire after this long if user never responds.
const STALE_AWAITING_CONFIRMATION_AFTER_MS = 7 * 24 * 60 * 60_000; // 7 days

function rowToJob(row: IngestJobRow, db?: ReturnType<typeof getIngestQueueDb>): IngestJob {
  const job: IngestJob = {
    jobId:       row.job_id,
    assetId:     row.asset_id,
    projectId:   row.project_id,
    filename:    row.filename,
    status:      row.status as IngestJobStatus,
    progress:    row.progress,
    error:       row.error ?? undefined,
    detail:      row.detail ?? undefined,
    tempPath:    row.temp_path ?? undefined,
    stablePath:  row.stable_path ?? undefined,
    queuedAt:    row.queued_at,
    updatedAt:   row.updated_at,
    completedAt: row.completed_at ?? undefined,
    batchId:     row.batch_id ?? undefined,
    fileSize:    row.file_size ?? undefined,
  };

  // For awaiting_confirmation jobs, attach upload session info so the
  // IngestTray can display confirm/decline buttons without a separate fetch.
  if (row.status === 'awaiting_confirmation' && db) {
    const session = db.prepare(
      `SELECT upload_id, version_meta_json FROM upload_sessions WHERE job_id = ? AND status = 'awaiting_confirmation' LIMIT 1`,
    ).get(row.job_id) as { upload_id: string; version_meta_json: string | null } | undefined;
    if (session) {
      job.uploadId = session.upload_id;
      if (session.version_meta_json) {
        try { job.versionMeta = JSON.parse(session.version_meta_json); } catch { /* ignore */ }
      }
    }
  }

  return job;
}

export class IngestQueueService {
  private cancelledIds = new Set<string>();
  private changeListeners: Array<(jobs: IngestJob[]) => void> = [];
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private io: SocketIOServer) {}

  onQueueChange(cb: (jobs: IngestJob[]) => void): void {
    this.changeListeners.push(cb);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    this.recoverOnBoot().catch((err) => console.error('[ingest-queue] boot recovery error:', err));
    this.purgeOldJobs();
    this.sweepStaleQueuedJobs();
    this.sweepStaleUploadSessions();
    this.staleTimer = setInterval(() => {
      this.sweepStaleQueuedJobs();
      this.sweepStaleUploadSessions();
    }, STALE_SWEEP_INTERVAL_MS);

    this.io.of('/media-ingest').on('connection', (socket) => {
      socket.emit('queue', this.getQueue());
      socket.on('cancel', (jobId: string) => this.cancel(jobId));
    });
    console.log('[ingest-queue] service running');
  }

  stop(): void {
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  // ── Public API (called by media/route.ts) ─────────────────────────────────

  /** Register a new ingest job. Returns the jobId. */
  add(projectId: string, filename: string, batchId?: string, fileSize?: number): string {
    const jobId = randomUUID();
    const queuedAt = new Date().toISOString();
    const db = getIngestQueueDb();
    db.prepare(`
      INSERT INTO ingest_jobs (job_id, asset_id, project_id, filename, status, progress, queued_at, updated_at, batch_id, file_size)
      VALUES (?, '', ?, ?, 'queued', 0, ?, ?, ?, ?)
    `).run(jobId, projectId, filename, queuedAt, queuedAt, batchId ?? null, fileSize ?? null);
    this.broadcast();
    recordActivity({
      ...serviceActor('Ingest Queue', 'ingest-queue'),
      occurred_at: queuedAt,
      event_type: 'ingest.queued',
      lifecycle_phase: 'queued',
      source_kind: 'background_service',
      visibility: 'user_timeline',
      title: `Ingest queued: ${filename}`,
      summary: `${filename} was queued for ingest`,
      project_id: projectId,
      job_id: jobId,
      source_service: 'ingest-queue',
      details_json: { filename },
    });
    return jobId;
  }

  /** Attach the real assetId once the file has been registered. */
  setAssetId(jobId: string, assetId: string): void {
    this.updateField(jobId, 'asset_id', assetId);
  }

  /** Record the temp file path for orphan cleanup. */
  setTempPath(jobId: string, tempPath: string): void {
    this.updateField(jobId, 'temp_path', tempPath);
  }

  /** Record the stable file path after rename. */
  setStablePath(jobId: string, stablePath: string): void {
    this.updateField(jobId, 'stable_path', stablePath);
  }

  /** Update progress (0-100) while streaming. */
  setProgress(jobId: string, progress: number, detail?: string): void {
    const existing = this.getJob(jobId);
    // Never overwrite a terminal or cancelled status — the job was resolved
    // before the stream completed (cancelled by user, failed, or done).
    if (!existing || existing.status === 'cancelled' || existing.status === 'done' || existing.status === 'failed' || existing.status === 'awaiting_confirmation') return;
    const firstStart = existing.status === 'queued';
    const db = getIngestQueueDb();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE ingest_jobs SET status = 'ingesting', progress = ?, detail = ?, error = NULL, updated_at = ?
      WHERE job_id = ? AND status NOT IN ('cancelled', 'done', 'failed', 'awaiting_confirmation')
    `).run(progress, detail ?? null, now, jobId);
    this.broadcast();
    if (firstStart && existing) {
      recordActivity({
        ...serviceActor('Ingest Queue', 'ingest-queue'),
        occurred_at: now,
        event_type: 'ingest.started',
        lifecycle_phase: 'running',
        source_kind: 'background_service',
        visibility: 'user_timeline',
        title: `Ingest started: ${existing.filename}`,
        summary: `${existing.filename} started ingesting`,
        project_id: existing.projectId,
        asset_id: existing.assetId || null,
        job_id: existing.jobId,
        source_service: 'ingest-queue',
        details_json: { filename: existing.filename, progress },
      });
    }
  }

  /** Mark a job as successfully completed. */
  complete(jobId: string): void {
    const existing = this.getJob(jobId);
    const now = new Date().toISOString();
    const db = getIngestQueueDb();
    db.prepare(`
      UPDATE ingest_jobs SET status = 'done', progress = 100, detail = NULL, error = NULL, completed_at = ?, updated_at = ?
      WHERE job_id = ?
    `).run(now, now, jobId);
    this.broadcast();
    if (existing) {
      recordActivity({
        ...serviceActor('Ingest Queue', 'ingest-queue'),
        occurred_at: now,
        event_type: 'ingest.completed',
        lifecycle_phase: 'completed',
        source_kind: 'background_service',
        visibility: 'user_timeline',
        title: `Ingest completed: ${existing.filename}`,
        summary: `${existing.filename} finished ingesting`,
        project_id: existing.projectId,
        asset_id: existing.assetId || null,
        job_id: existing.jobId,
        source_service: 'ingest-queue',
        details_json: { filename: existing.filename },
      });
    }
  }

  /** Mark a job as failed with an error message. No-op if the job is already terminal. */
  fail(jobId: string, error: string): void {
    const existing = this.getJob(jobId);
    if (!existing || existing.status === 'done' || existing.status === 'cancelled') return;
    const now = new Date().toISOString();
    const db = getIngestQueueDb();
    db.prepare(`
      UPDATE ingest_jobs SET status = 'failed', error = ?, detail = NULL, completed_at = ?, updated_at = ?
      WHERE job_id = ? AND status NOT IN ('done', 'cancelled')
    `).run(error, now, now, jobId);
    this.broadcast();
    if (existing) {
      recordActivity({
        ...serviceActor('Ingest Queue', 'ingest-queue'),
        occurred_at: now,
        event_type: 'ingest.failed',
        lifecycle_phase: 'failed',
        source_kind: 'background_service',
        visibility: 'user_timeline',
        title: `Ingest failed: ${existing.filename}`,
        summary: `${existing.filename} failed during ingest`,
        project_id: existing.projectId,
        asset_id: existing.assetId || null,
        job_id: existing.jobId,
        source_service: 'ingest-queue',
        details_json: { filename: existing.filename, error },
      });
    }
  }

  /** Mark a job as awaiting user confirmation (version bump). Not a failure. */
  setAwaitingConfirmation(jobId: string): void {
    const existing = this.getJob(jobId);
    if (!existing || existing.status === 'done' || existing.status === 'cancelled') return;
    const now = new Date().toISOString();
    const db = getIngestQueueDb();
    db.prepare(`
      UPDATE ingest_jobs SET status = 'awaiting_confirmation', error = NULL, detail = NULL, completed_at = ?, updated_at = ?
      WHERE job_id = ? AND status NOT IN ('done', 'cancelled')
    `).run(now, now, jobId);
    this.broadcast();
  }

  /** Cancel a job — broadcasts immediately, route discards the file on finish. */
  cancel(jobId: string): void {
    this.cancelledIds.add(jobId);
    const existing = this.getJob(jobId);
    const now = new Date().toISOString();
    const db = getIngestQueueDb();
    db.prepare(`
      UPDATE ingest_jobs SET status = 'cancelled', detail = NULL, error = NULL, completed_at = ?, updated_at = ?
      WHERE job_id = ?
    `).run(now, now, jobId);
    this.broadcast();
    if (existing) {
      recordActivity({
        ...serviceActor('Ingest Queue', 'ingest-queue'),
        occurred_at: now,
        event_type: 'ingest.cancelled',
        lifecycle_phase: 'cancelled',
        source_kind: 'background_service',
        visibility: 'operator_only',
        title: `Ingest cancelled: ${existing.filename}`,
        summary: `${existing.filename} ingest was cancelled`,
        project_id: existing.projectId,
        asset_id: existing.assetId || null,
        job_id: existing.jobId,
        source_service: 'ingest-queue',
        details_json: { filename: existing.filename },
      });
    }
  }

  /** Returns true if the job has been cancelled. Checks both in-memory Set and
   *  DB status so the check survives server restarts / hot reloads. */
  isCancelled(jobId: string): boolean {
    if (this.cancelledIds.has(jobId)) return true;
    const db = getIngestQueueDb();
    const row = db.prepare(
      "SELECT status FROM ingest_jobs WHERE job_id = ?",
    ).get(jobId) as { status: string } | undefined;
    return row?.status === 'cancelled';
  }

  /** Returns active + recently-completed jobs (last 5 minutes). */
  getQueue(): IngestJob[] {
    const db = getIngestQueueDb();
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();

    // Two separate indexed queries instead of a single OR-branch scan.
    // The OR clause prevented SQLite from using idx_ingest_jobs_status and
    // forced a full table scan on every call.
    const active = db.prepare(
      `SELECT * FROM ingest_jobs WHERE status IN ('queued','ingesting') ORDER BY queued_at ASC`,
    ).all() as IngestJobRow[];

    const recent = db.prepare(
      `SELECT * FROM ingest_jobs
       WHERE completed_at IS NOT NULL AND completed_at > ?
         AND status NOT IN ('queued','ingesting')
       ORDER BY queued_at ASC`,
    ).all(cutoff) as IngestJobRow[];

    // Merge, deduplicate by job_id, re-sort chronologically.
    const seen = new Set<string>();
    const merged: IngestJobRow[] = [];
    for (const row of [...active, ...recent]) {
      if (!seen.has(row.job_id)) { seen.add(row.job_id); merged.push(row); }
    }
    merged.sort((a, b) => a.queued_at.localeCompare(b.queued_at));
    return merged.map((row) => rowToJob(row, db));
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private getJob(jobId: string): IngestJob | null {
    const db = getIngestQueueDb();
    const row = db.prepare('SELECT * FROM ingest_jobs WHERE job_id = ?').get(jobId) as IngestJobRow | undefined;
    return row ? rowToJob(row, db) : null;
  }

  private updateField(jobId: string, column: string, value: string): void {
    const db = getIngestQueueDb();
    db.prepare(`UPDATE ingest_jobs SET ${column} = ?, updated_at = ? WHERE job_id = ?`)
      .run(value, new Date().toISOString(), jobId);
    this.broadcast();
  }

  private broadcast(): void {
    const queue = this.getQueue();
    this.io.of('/media-ingest').emit('queue', queue);
    this.changeListeners.forEach((cb) => cb(queue));
  }

  // ── Boot recovery ─────────────────────────────────────────────────────────

  private async recoverOnBoot(): Promise<void> {
    const db = getIngestQueueDb();
    const incomplete = db.prepare(
      "SELECT * FROM ingest_jobs WHERE status IN ('queued', 'ingesting')",
    ).all() as IngestJobRow[];

    if (incomplete.length === 0) return;

    let cleaned = 0;
    let resumed = 0;
    for (const row of incomplete) {
      // If asset was registered (assetId set) AND stable file exists, the ingest
      // was essentially complete — just mark done.
      if (row.asset_id && row.stable_path) {
        try {
          await fs.promises.access(row.stable_path);
          const now = new Date().toISOString();
          db.prepare(
            "UPDATE ingest_jobs SET status = 'done', progress = 100, completed_at = ?, updated_at = ? WHERE job_id = ?",
          ).run(now, now, row.job_id);
          continue;
        } catch { /* fall through to cleanup */ }
      }

      // Chunked upload: if an upload_sessions row exists with status='uploading'
      // and the temp file is still on disk, the upload is resumable — reset the
      // job to 'queued' so the IngestTray shows a resume prompt.
      const session = db.prepare(
        "SELECT upload_id, temp_path, bytes_received, file_size FROM upload_sessions WHERE job_id = ? AND status = 'uploading' LIMIT 1",
      ).get(row.job_id) as { upload_id: string; temp_path: string; bytes_received: number; file_size: number } | undefined;

      if (session) {
        let tempExists = false;
        try { await fs.promises.access(session.temp_path); tempExists = true; } catch { /* missing */ }

        if (tempExists) {
          // Temp file intact — mark job resumable (queued) and refresh session timestamp.
          const now = new Date().toISOString();
          const pct = session.file_size > 0
            ? Math.min(94, Math.round((session.bytes_received / session.file_size) * 100))
            : 0;
          db.prepare(
            "UPDATE ingest_jobs SET status = 'queued', progress = ?, error = NULL, detail = 'Resume upload to continue', updated_at = ? WHERE job_id = ?",
          ).run(pct, now, row.job_id);
          db.prepare(
            "UPDATE upload_sessions SET updated_at = ? WHERE upload_id = ?",
          ).run(now, session.upload_id);
          resumed++;
          continue;
        }

        // Session exists but temp file is gone — cancel the session.
        const now = new Date().toISOString();
        db.prepare(
          "UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE upload_id = ?",
        ).run(now, session.upload_id);
      }

      // Clean up orphaned files
      if (row.temp_path) {
        try { await fs.promises.unlink(row.temp_path); } catch { /* already gone */ }
      }
      if (row.stable_path && !row.asset_id) {
        try { await fs.promises.unlink(row.stable_path); } catch { /* already gone */ }
      }

      const now = new Date().toISOString();
      db.prepare(
        "UPDATE ingest_jobs SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE job_id = ?",
      ).run('Interrupted by server restart', now, now, row.job_id);
      cleaned++;
    }

    if (resumed > 0) console.log(`[ingest-queue] ${resumed} chunked upload(s) ready to resume`);
    if (cleaned > 0) console.log(`[ingest-queue] cleaned up ${cleaned} interrupted ingest(s)`);
  }

  private sweepStaleUploadSessions(): void {
    const db = getIngestQueueDb();
    const now = new Date().toISOString();

    // Uploading sessions with no progress for >1 hour.
    const uploadingCutoff = new Date(Date.now() - STALE_UPLOAD_SESSION_AFTER_MS).toISOString();
    const staleSessions = db.prepare(
      "SELECT upload_id, temp_path, job_id FROM upload_sessions WHERE status = 'uploading' AND updated_at < ?",
    ).all(uploadingCutoff) as { upload_id: string; temp_path: string; job_id: string }[];

    for (const session of staleSessions) {
      try { fs.unlinkSync(session.temp_path); } catch { /* already gone */ }
      db.prepare("UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE upload_id = ?")
        .run(now, session.upload_id);
      this.fail(session.job_id, 'Upload session timed out after 1 hour of inactivity');
    }

    // awaiting_confirmation sessions older than 7 days — user never responded.
    const confirmCutoff = new Date(Date.now() - STALE_AWAITING_CONFIRMATION_AFTER_MS).toISOString();
    const staleConfirm = db.prepare(
      "SELECT upload_id, temp_path, job_id FROM upload_sessions WHERE status = 'awaiting_confirmation' AND updated_at < ?",
    ).all(confirmCutoff) as { upload_id: string; temp_path: string; job_id: string }[];

    for (const session of staleConfirm) {
      try { fs.unlinkSync(session.temp_path); } catch { /* already gone */ }
      db.prepare("UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE upload_id = ?")
        .run(now, session.upload_id);
      this.fail(session.job_id, 'Version confirmation expired after 7 days');
    }

    if (staleSessions.length + staleConfirm.length > 0) {
      console.log(`[ingest-queue] swept ${staleSessions.length} stale upload session(s), ${staleConfirm.length} expired confirmation(s)`);
      this.broadcast();
    }
  }

  private sweepStaleQueuedJobs(): void {
    const db = getIngestQueueDb();
    const cutoff = new Date(Date.now() - STALE_QUEUED_AFTER_MS).toISOString();

    // Candidates: queued, no temp_path (upload never began), older than threshold.
    const candidates = db.prepare(
      "SELECT * FROM ingest_jobs WHERE status = 'queued' AND temp_path IS NULL AND queued_at < ?",
    ).all(cutoff) as IngestJobRow[];

    if (candidates.length === 0) return;

    // For batched jobs: skip if any sibling in the batch has started uploading.
    // This prevents false-positives when a large file takes >10 min to upload and
    // other files in the same batch are still waiting their turn in the loop.
    const stale = candidates.filter((row) => {
      if (!row.batch_id) return true; // no batch — use old logic
      const sibling = db.prepare(
        "SELECT 1 FROM ingest_jobs WHERE batch_id = ? AND temp_path IS NOT NULL LIMIT 1",
      ).get(row.batch_id);
      return !sibling; // only stale if no sibling has started uploading
    });

    if (stale.length === 0) return;

    const now = new Date().toISOString();
    const ids = stale.map((r) => r.job_id);
    db.prepare(
      `UPDATE ingest_jobs SET status = 'failed',
       error = 'Upload never started — browser may have left the page',
       completed_at = ?, updated_at = ?
       WHERE job_id IN (${ids.map(() => '?').join(',')})`,
    ).run(now, now, ...ids);

    console.log(`[ingest-queue] swept ${stale.length} stale queued job(s)`);
    this.broadcast();
  }

  private purgeOldJobs(): void {
    const db = getIngestQueueDb();
    const cutoff = new Date(Date.now() - PURGE_AGE_MS).toISOString();
    const result = db.prepare(
      "DELETE FROM ingest_jobs WHERE status IN ('done', 'failed', 'cancelled') AND completed_at < ?",
    ).run(cutoff);
    if (typeof result === 'object' && result !== null && 'changes' in result) {
      const changes = (result as { changes: number }).changes;
      if (changes > 0) {
        console.log(`[ingest-queue] purged ${changes} old job(s)`);
      }
    }
  }
}
