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
import {
  getOrCreateProjectFolder,
  uploadAsset,
  createVersionStack,
  addFileToVersionStack,
}                                                  from '@/lib/services/frameio';
import {
  compressForFrameIO,
  cancelCompress,
  COMPRESS_THRESHOLD_BYTES,
}                                                  from '@/lib/services/frameio-compress';
import { triggerCloudflareUpload }                 from '@/lib/services/cloudflare-publish';
import { getDefaultAllowedOrigins }                from '@/lib/services/cloudflare-stream';
import { isVideoFile }                             from '@/lib/utils/media-kind';

function getQueue() {
  try { return getUploadQueueService(); } catch { return null; }
}

interface FrameIOUploadContext {
  actor?: ActivityActor;
  clientId?: string | null;
  /** Frame.io file ID of the prior version. When set, a version stack is created or extended. */
  priorFrameioFileId?: string | null;
  /** Existing Frame.io version stack ID. When set, the new file is moved into this stack. */
  priorFrameioStackId?: string | null;
  /** One-shot operator opt-out (NAS mode "Skip Cloudflare for next upload").
   *  Frame.io still runs; only the chained Cloudflare Stream auto-upload is skipped. */
  skipCloudflare?: boolean;
}

export function triggerFrameIOUpload(projectId: string, assetId: string, context?: FrameIOUploadContext): void {
  // Fire-and-forget — returns immediately, runs in background
  setImmediate(() => { void runUpload(projectId, assetId, context); });
}

async function runUpload(projectId: string, assetId: string, context?: FrameIOUploadContext): Promise<void> {
  const asset = getAsset(projectId, assetId);
  if (!asset || !asset.filePath) return;

  // Guard: don't re-upload if already uploaded or in progress (CF already handled too)
  if (asset.frameio.status !== 'none') return;

  // Cloudflare upload is INDEPENDENT of Frame.io's outcome — a fresh video asset
  // gets onto CF whether Frame.io succeeds, fails, or is unreachable. Defined
  // here so every exit path below can fire it after the Frame.io attempt.
  // Frame.io is still attempted first when connected (preserving sequencing so
  // the same file isn't uploading to both at once); the cloudflare-publish guard
  // prevents a duplicate in-flight CF upload.
  const fireCloudflare = () => {
    if (context?.skipCloudflare) {
      console.log(`[frameio] skipping Cloudflare auto-upload for "${asset.name}" (operator opted out for this upload)`);
      return;
    }
    if (isVideoFile(asset.mimeType, asset.originalFilename ?? asset.name)) {
      triggerCloudflareUpload(projectId, assetId, { allowedOrigins: getDefaultAllowedOrigins() });
    } else {
      console.log(`[frameio] skipping Cloudflare auto-upload for non-video asset "${asset.name}"`);
    }
  };

  // Frame.io disconnected — skip the Frame.io attempt, but still get CF.
  if (!isConnected()) {
    console.warn(`[frameio-upload] Frame.io disconnected — uploading "${asset.name}" to Cloudflare only`);
    fireCloudflare();
    return;
  }

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
    const fileSize    = asset.fileSize || (await fs.promises.stat(asset.filePath)).size;
    if (!fileSize) throw new Error(`Cannot upload "${filename}" to Frame.io — file size is 0 or unknown`);
    let   uploadPath  = asset.filePath;
    let   uploadSize  = fileSize;
    let   uploadName  = filename;

    // Frame.io derives the file's media_type from the name extension at create
    // time (POST .../files/local_upload) and signs each presigned upload_url with
    // that value as the S3 Content-Type. An extension-less display name (e.g.
    // `asset.name = "LeaderPass Homepage Video"`) makes Frame.io default to
    // image/jpeg → the file is permanently categorized as an image and video
    // playback breaks (LPOS's /frameio-stream then returns image_full_xxxx.jpg).
    // Borrow the real extension from originalFilename when the display name has
    // none, so Frame.io guesses correctly from the start.
    if (!/\.[A-Za-z0-9]{1,5}$/.test(uploadName)) {
      const ext = (asset.originalFilename || asset.filePath || '').match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? '';
      if (ext) uploadName = uploadName + ext;
    }

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
      uploadSize = (await fs.promises.stat(outputPath)).size;
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

    // ── Version stacking ──────────────────────────────────────────────────────
    // If this upload replaces a prior version, group the files into a Frame.io
    // version stack so existing review/share links continue pointing at the same
    // asset and automatically show the newest version.
    let stackId: string | null = context?.priorFrameioStackId ?? null;
    let stackViewUrl: string | null = null;

    if (context?.priorFrameioStackId) {
      // Stack already exists — move the new file into it.
      try {
        await addFileToVersionStack(result.frameioAssetId, context.priorFrameioStackId);
      } catch (err) {
        console.warn('[frameio] could not add file to version stack (non-fatal):', (err as Error).message);
        stackId = null;
      }
    } else if (context?.priorFrameioFileId) {
      // First version replacement — group v1 and v2 into a Frame.io version stack.
      try {
        const stackResult = await createVersionStack(folderId, context.priorFrameioFileId, result.frameioAssetId);
        stackId      = stackResult.stackId;
        stackViewUrl = stackResult.viewUrl;
      } catch (err) {
        console.warn('[frameio] could not create version stack (non-fatal):', (err as Error).message);
      }
    }

    patchAsset(projectId, assetId, {
      frameio: {
        assetId:    result.frameioAssetId,
        stackId:    stackId,
        reviewLink: stackViewUrl ?? result.reviewLink,
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

    // Frame.io succeeded → upload to Cloudflare (sequential, after Frame.io).
    fireCloudflare();

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
      // Frame.io upload failed — still get the asset onto Cloudflare.
      fireCloudflare();
    }

  } finally {
    // Always clean up the temp proxy — original file is never touched
    if (proxyPath) {
      try { await fs.promises.unlink(proxyPath); } catch { /* ignore */ }
    }
  }
}
