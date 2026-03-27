/**
 * frameio-upload.ts
 *
 * Shared helper to trigger a background Frame.io upload for any registered
 * media asset. Called from:
 *   - the media upload route   (on file copy-in)
 *   - the media register route (on register-in-place)
 *   - the frameio API route    (on manual trigger)
 *
 * Silently skips if Frame.io is not connected or asset has no file path.
 * Reports progress to UploadQueueService → broadcast to UploadTray UI.
 */

import fs                                          from 'node:fs';
import type { ActivityActor }                     from '@/lib/models/activity';
import { getAsset, patchAsset }                   from '@/lib/store/media-registry';
import { getProjectStore, getUploadQueueService } from '@/lib/services/container';
import { recordActivity, serviceActor }           from '@/lib/services/activity-monitor-service';
import { isConnected }                            from '@/lib/services/frameio-tokens';
import { getOrCreateProjectFolder, uploadAsset }  from '@/lib/services/frameio';
import {
  compressForFrameIO,
  cancelCompress,
  COMPRESS_THRESHOLD_BYTES,
}                                                  from '@/lib/services/frameio-compress';

function getQueue() {
  try { return getUploadQueueService(); } catch { return null; }
}

interface FrameIOUploadContext {
  actor?: ActivityActor;
  clientId?: string | null;
}

export function triggerFrameIOUpload(projectId: string, assetId: string, context?: FrameIOUploadContext): void {
  // Fire-and-forget — returns immediately, runs in background
  setImmediate(() => { void runUpload(projectId, assetId, context); });
}

async function runUpload(projectId: string, assetId: string, context?: FrameIOUploadContext): Promise<void> {
  // Guard: Frame.io must be connected
  if (!isConnected()) return;

  const asset = getAsset(projectId, assetId);
  if (!asset || !asset.filePath) return;

  // Guard: don't re-upload if already uploaded or in progress
  if (asset.frameio.status !== 'none') return;

  const queue    = getQueue();
  const filename = asset.name || asset.originalFilename;
  const jobId    = queue?.add(projectId, assetId, filename) ?? null;
  const actor = context?.actor ?? serviceActor('Frame.io Upload', 'frameio-upload');
  const clientId = context?.clientId ?? getProjectStore().getById(projectId)?.clientName ?? null;

  recordActivity({
    ...actor,
    occurred_at: new Date().toISOString(),
    event_type: 'frameio.upload.queued',
    lifecycle_phase: 'queued',
    source_kind: 'background_service',
    visibility: 'user_timeline',
    title: `Frame.io upload queued: ${filename}`,
    summary: `${filename} was queued for Frame.io upload`,
    client_id: clientId,
    project_id: projectId,
    asset_id: assetId,
    job_id: jobId,
    source_service: 'frameio-upload',
    details_json: { provider: 'frameio', filename },
  });

  patchAsset(projectId, assetId, { frameio: { status: 'uploading', lastError: null } });

  // Track any temp proxy file so we can clean it up regardless of outcome
  let proxyPath: string | null = null;

  try {
    const project     = getProjectStore().getById(projectId);
    const projectName = project?.name ?? projectId;
    const folderId    = await getOrCreateProjectFolder(projectName);

    // ── Compression (transparent, only for files ≥ 1.9 GB) ───────────────
    const fileSize    = asset.fileSize || fs.statSync(asset.filePath).size;
    if (!fileSize) throw new Error(`Cannot upload "${filename}" to Frame.io — file size is 0 or unknown`);
    let   uploadPath  = asset.filePath;
    let   uploadSize  = fileSize;
    let   uploadName  = filename;

    if (fileSize >= COMPRESS_THRESHOLD_BYTES) {
      console.log(`[frameio] "${filename}" is ${(fileSize / 1e9).toFixed(2)} GB — compressing before upload`);
      queue?.setCompressing(jobId!, 0);

      const { outputPath } = await compressForFrameIO(
        asset.filePath,
        (pct) => {
          if (jobId && queue?.isCancelled(jobId)) { cancelCompress(jobId); return; }
          queue?.setCompressing(jobId!, pct);
        },
        jobId ?? undefined,
      );

      proxyPath  = outputPath;
      uploadPath = outputPath;
      uploadSize = fs.statSync(outputPath).size;
      // Keep original extension on the Frame.io filename so it's recognisable
      console.log(`[frameio] compressed to ${(uploadSize / 1e9).toFixed(2)} GB — uploading proxy`);
    }

    // ── Upload ────────────────────────────────────────────────────────────
    // Check cancellation before starting S3 upload
    if (jobId && queue?.isCancelled(jobId)) throw new Error('Cancelled');

    queue?.setProgress(jobId!, 5);
    recordActivity({
      ...actor,
      occurred_at: new Date().toISOString(),
      event_type: 'frameio.upload.started',
      lifecycle_phase: 'running',
      source_kind: 'background_service',
      visibility: 'user_timeline',
      title: `Frame.io upload started: ${filename}`,
      summary: `${filename} started uploading to Frame.io`,
      client_id: clientId,
      project_id: projectId,
      asset_id: assetId,
      job_id: jobId,
      source_service: 'frameio-upload',
      details_json: { provider: 'frameio', filename },
    });

    const result = await uploadAsset(
      folderId,
      uploadName,
      uploadPath,
      asset.mimeType ?? 'video/mp4',
      uploadSize,
      jobId ? () => queue?.isCancelled(jobId) ?? false : undefined,
    );

    queue?.setProgress(jobId!, 95);

    patchAsset(projectId, assetId, {
      frameio: {
        assetId:    result.frameioAssetId,
        reviewLink: result.reviewLink,
        playerUrl:  result.playerUrl,
        status:     'in_review',
        uploadedAt: new Date().toISOString(),
        lastError:  null,
      },
    });

    if (jobId) queue?.complete(jobId);
    recordActivity({
      ...actor,
      occurred_at: new Date().toISOString(),
      event_type: 'frameio.upload.completed',
      lifecycle_phase: 'completed',
      source_kind: 'background_service',
      visibility: 'user_timeline',
      title: `Frame.io upload completed: ${filename}`,
      summary: `${filename} finished uploading to Frame.io`,
      client_id: clientId,
      project_id: projectId,
      asset_id: assetId,
      job_id: jobId,
      source_service: 'frameio-upload',
      details_json: {
        provider: 'frameio',
        frameioAssetId: result.frameioAssetId,
        reviewLink: result.reviewLink,
        playerUrl: result.playerUrl,
      },
    });
    console.log(`[frameio] uploaded "${filename}" → ${result.reviewLink ?? result.frameioAssetId}`);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Cancelled') {
      // Job already marked cancelled by the service — just reset the asset status
      patchAsset(projectId, assetId, { frameio: { status: 'none', lastError: null } });
      recordActivity({
        ...actor,
        occurred_at: new Date().toISOString(),
        event_type: 'frameio.upload.cancelled',
        lifecycle_phase: 'cancelled',
        source_kind: 'background_service',
        visibility: 'operator_only',
        title: `Frame.io upload cancelled: ${filename}`,
        summary: `${filename} upload to Frame.io was cancelled`,
        client_id: clientId,
        project_id: projectId,
        asset_id: assetId,
        job_id: jobId,
        source_service: 'frameio-upload',
        details_json: { provider: 'frameio' },
      });
      console.log(`[frameio] upload cancelled for "${filename}"`);
    } else {
      console.error('[frameio] upload failed:', message);
      patchAsset(projectId, assetId, { frameio: { status: 'none', lastError: message } });
      if (jobId) queue?.fail(jobId, message);
      recordActivity({
        ...actor,
        occurred_at: new Date().toISOString(),
        event_type: 'frameio.upload.failed',
        lifecycle_phase: 'failed',
        source_kind: 'background_service',
        visibility: 'user_timeline',
        title: `Frame.io upload failed: ${filename}`,
        summary: `${filename} failed to upload to Frame.io`,
        client_id: clientId,
        project_id: projectId,
        asset_id: assetId,
        job_id: jobId,
        source_service: 'frameio-upload',
        details_json: { provider: 'frameio', error: message },
      });
    }

  } finally {
    // Always clean up the temp proxy — original file is never touched
    if (proxyPath) {
      try { fs.unlinkSync(proxyPath); } catch { /* ignore */ }
    }
  }
}
