/**
 * PromotionProcessor
 *
 * Processes promotion jobs from the PromotionQueueService one at a time.
 * For each job:
 *   1. Downloads the file from R2 via the ingest app's download endpoint
 *   2. Routes to Google Drive (docs/images) or local storage (video)
 *   3. Creates a drive_assets record
 *   4. Marks the ingest submission as processed in Railway Postgres
 *   5. Emits drive:file-synced so Assets tab updates live
 */

import fs   from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';
import type { PromotionQueueService, PromotionJob } from './promotion-queue-service';
import { upsertDriveAsset } from '@/lib/store/drive-sync-db';
import { uploadFile } from '@/lib/services/drive-client';
import { getStorageAllocationDecision } from '@/lib/services/storage-volume-service';
import { getCachedProjectFolders } from '@/lib/services/drive-folder-service';
import { getIngestDb } from '@/lib/ingest-db';

const INGEST_APP_URL  = process.env.INGEST_APP_URL ?? '';
const MAX_CONCURRENCY = 2;

export class PromotionProcessor {
  private active = new Set<string>();

  constructor(
    private queue: PromotionQueueService,
    private io: SocketIOServer | undefined,
  ) {
    this.queue.onQueueChange(() => this.processNext());
  }

  start(): void {
    console.log('[promotion-processor] running');
    this.processNext();
  }

  private processNext(): void {
    if (this.active.size >= MAX_CONCURRENCY) return;
    const next = this.queue.getQueue().find((j) => j.status === 'queued');
    if (!next) return;
    this.active.add(next.jobId);
    void this.process(next).finally(() => {
      this.active.delete(next.jobId);
      setImmediate(() => this.processNext());
    });
  }

  private async process(job: PromotionJob): Promise<void> {
    try {
      // ── Step 1: Resolve the ingest token for this project ──────────────────
      const db = getIngestDb();
      const clientRow = await db.query(
        'SELECT token FROM ingest_clients WHERE lpos_project_id = $1 AND active = true',
        [job.projectId],
      );
      if (!clientRow.rows.length) throw new Error('No ingest client found for project');
      const { token } = clientRow.rows[0] as { token: string };

      // ── Step 2: Download from R2 via ingest app ────────────────────────────
      this.queue.setDownloading(job.jobId, 5);
      const downloadUrl = `${INGEST_APP_URL}/c/${token}/download?key=${encodeURIComponent(job.fileKey)}`;
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

      const contentLength = Number(res.headers.get('content-length') ?? job.fileSize ?? 0);
      const chunks: Uint8Array[] = [];
      let received = 0;

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (contentLength > 0) {
          const pct = Math.round((received / contentLength) * 50); // 0–50 for download phase
          this.queue.setDownloading(job.jobId, 5 + pct);
        }
      }

      const buffer = Buffer.concat(chunks);
      this.queue.setPromoting(job.jobId, 55);

      // ── Step 3: Route to Drive or local storage ────────────────────────────
      const entityId = randomUUID();
      const now      = new Date().toISOString();

      if (job.storageType === 'local') {
        await this.promoteToLocal(job, buffer, entityId, now);
      } else {
        await this.promoteToDrive(job, buffer, entityId, now);
      }

      // ── Step 4: Mark ingest submission processed ───────────────────────────
      await db.query(
        `UPDATE ingest_submissions
         SET processed = true, promoted_to = $1, promoted_at = $2
         WHERE file_key = $3`,
        [job.destination, now, job.fileKey],
      );

      this.queue.complete(job.jobId, entityId);

      // Broadcast so Assets tab refreshes
      this.io?.emit('drive:file-synced', {
        entityType: 'asset',
        entityId,
        projectId: job.projectId,
        name: job.filename,
      });
    } catch (err) {
      this.queue.fail(job.jobId, (err as Error).message);
    }
  }

  // ── Drive promotion (docs, images) ────────────────────────────────────────

  private async promoteToDrive(
    job: PromotionJob,
    buffer: Buffer,
    entityId: string,
    now: string,
  ): Promise<void> {
    // Resolve Drive Assets (or Scripts) folder for this project
    // We need project name + client name from the project store
    const { getProjectStore } = await import('@/lib/services/container');
    const project = getProjectStore().getById(job.projectId);
    if (!project) throw new Error('Project not found');

    const folders = getCachedProjectFolders(project.name, project.clientName);
    if (!folders) throw new Error('Drive folders not set up for this project — open the Assets tab first to initialise them');

    const folderId = job.destination === 'scripts' ? folders.scripts : folders.assets;

    this.queue.setPromoting(job.jobId, 60);
    const { fileId, webViewLink } = await uploadFile(job.filename, job.mimeType, buffer, folderId);
    this.queue.setPromoting(job.jobId, 90);

    upsertDriveAsset({
      entityType:   job.destination === 'scripts' ? 'script' : 'asset',
      entityId,
      projectId:    job.projectId,
      driveFileId:  fileId,
      driveFolderId: folderId,
      name:         job.filename,
      mimeType:     job.mimeType,
      webViewLink,
      isFolder:     false,
      fileSize:     buffer.length,
      modifiedAt:   now,
      source:       'drive',
    });
  }

  // ── Local promotion (videos) ──────────────────────────────────────────────

  private async promoteToLocal(
    job: PromotionJob,
    buffer: Buffer,
    entityId: string,
    now: string,
  ): Promise<void> {
    const decision  = getStorageAllocationDecision();
    if (!decision.active) throw new Error('No active storage volume configured — set one in Admin > Storage');
    const assetsDir = path.join(decision.active.managedRoot, 'projects', job.projectId, 'client-assets');
    fs.mkdirSync(assetsDir, { recursive: true });

    this.queue.setPromoting(job.jobId, 70);
    const localPath = path.join(assetsDir, `${Date.now()}-${job.filename}`);
    fs.writeFileSync(localPath, buffer);
    this.queue.setPromoting(job.jobId, 90);

    // Use synthetic drive_file_id so NOT NULL UNIQUE constraint is satisfied
    upsertDriveAsset({
      entityType:  'asset',
      entityId,
      projectId:   job.projectId,
      driveFileId: `local:${entityId}`,
      name:        job.filename,
      mimeType:    job.mimeType,
      isFolder:    false,
      localPath,
      fileSize:    buffer.length,
      modifiedAt:  now,
      source:      'local',
    });
  }
}
