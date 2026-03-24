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
import { getAsset, patchAsset }                   from '@/lib/store/media-registry';
import { getProjectStore, getUploadQueueService } from '@/lib/services/container';
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

export function triggerFrameIOUpload(projectId: string, assetId: string): void {
  // Fire-and-forget — returns immediately, runs in background
  setImmediate(() => { void runUpload(projectId, assetId); });
}

async function runUpload(projectId: string, assetId: string): Promise<void> {
  // Guard: Frame.io must be connected
  if (!isConnected()) return;

  const asset = getAsset(projectId, assetId);
  if (!asset || !asset.filePath) return;

  // Guard: don't re-upload if already uploaded or in progress
  if (asset.frameio.status !== 'none') return;

  const queue    = getQueue();
  const filename = asset.name || asset.originalFilename;
  const jobId    = queue?.add(projectId, assetId, filename) ?? null;

  patchAsset(projectId, assetId, { frameio: { status: 'uploading', lastError: null } });

  // Track any temp proxy file so we can clean it up regardless of outcome
  let proxyPath: string | null = null;

  try {
    const project     = getProjectStore().getById(projectId);
    const projectName = project?.name ?? projectId;
    const folderId    = await getOrCreateProjectFolder(projectName);

    // ── Compression (transparent, only for files ≥ 1.9 GB) ───────────────
    const fileSize    = asset.fileSize ?? fs.statSync(asset.filePath).size;
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
    console.log(`[frameio] uploaded "${filename}" → ${result.reviewLink ?? result.frameioAssetId}`);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Cancelled') {
      // Job already marked cancelled by the service — just reset the asset status
      patchAsset(projectId, assetId, { frameio: { status: 'none', lastError: null } });
      console.log(`[frameio] upload cancelled for "${filename}"`);
    } else {
      console.error('[frameio] upload failed:', message);
      patchAsset(projectId, assetId, { frameio: { status: 'none', lastError: message } });
      if (jobId) queue?.fail(jobId, message);
    }

  } finally {
    // Always clean up the temp proxy — original file is never touched
    if (proxyPath) {
      try { fs.unlinkSync(proxyPath); } catch { /* ignore */ }
    }
  }
}
