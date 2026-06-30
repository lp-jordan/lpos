import fs from 'node:fs';
import type { ActivityActor } from '@/lib/models/activity';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getLatestDistributionInfoForAsset } from '@/lib/store/canonical-asset-store';
import { recordOrphan } from '@/lib/store/cloudflare-orphan-store';
import { probeMediaInfo } from '@/lib/services/media-probe';
import { getTranscriptPaths } from '@/lib/transcripts/store';
import {
  applyVideoSettings,
  createCloudflareTusUpload,
  deleteCloudflareVideo,
  getCloudflareStreamConfigDiagnostic,
  getCloudflareFileSize,
  isCloudflareStreamConfigured,
  uploadCaptionsVtt,
  uploadFileToCloudflareTus,
  waitForCloudflareVideoReady,
} from '@/lib/services/cloudflare-stream';

/**
 * Cloudflare Stream upload — decoupled from LeaderPass publish.
 *
 * This is the lean, Cloudflare-only upload path used to make CF the primary
 * internal playback layer (sidebar/theater player + scrub thumbnails). It
 * orchestrates the same low-level cloudflare-stream.ts primitives as
 * leaderpass-publish.ts, but does NOT touch `asset.leaderpass.*`, build the
 * LeaderPass `pendingPayload`/`awaiting_platform` handoff, or hardcode the
 * leaderpass playback origin. `allowedOrigins` is caller-supplied.
 *
 * Phase 0 of the CF auto-upload build (see the project_cloudflare_auto_upload
 * memory). It is intentionally standalone so the live manual "Push to
 * Cloudflare" flow (leaderpass-publish.ts) stays byte-identical; the temporary
 * orchestration overlap between the two is reconciled in a later cleanup once
 * auto-upload is proven.
 *
 * NOTE: signed URLs are deliberately NOT enabled here. The interim security
 * model is `allowedOrigins` only (LPOS host + downstream platform domain);
 * `requireSignedURLs` waits on the LeaderPass UID-based tether, because turning
 * it on would 403 LPOS's own raw-HLS player + thumbnails until token minting
 * exists on both sides.
 *
 * Follow-ups deferred from Phase 0 (wired in Phase 1+): UploadTray queue job +
 * cancellation, activity-timeline events, and the manual-push concurrency guard
 * widening (leaderpass-publish only skips on cloudflare.status==='processing',
 * not 'uploading').
 */

const CLOUDFLARE_DEFAULT_THUMBNAIL_FRAME = 24;

/** Pull the custom poster URL out of a prior CF distribution's metadata_json, if any. */
function readPriorPosterUrl(prior: { metadata_json: string | null } | null): string | null {
  if (!prior?.metadata_json) return null;
  try {
    const meta = JSON.parse(prior.metadata_json) as { posterUrl?: unknown };
    return typeof meta.posterUrl === 'string' && meta.posterUrl ? meta.posterUrl : null;
  } catch {
    return null;
  }
}

export interface CloudflareUploadOptions {
  /**
   * Origins permitted to play this video (LPOS host + any downstream platform
   * domain). Omit or pass an empty array to leave the video unrestricted.
   */
  allowedOrigins?: string[] | null;
  /** Reserved for activity-timeline attribution once events are wired. */
  actor?: ActivityActor;
}

export function canUploadToCloudflare(): boolean {
  return isCloudflareStreamConfigured();
}

/** Fire-and-forget background Cloudflare upload. */
export function triggerCloudflareUpload(
  projectId: string,
  assetId: string,
  options?: CloudflareUploadOptions,
): void {
  setImmediate(() => {
    void runCloudflareUpload(projectId, assetId, options).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[cloudflare-publish] unhandled upload failure for asset ${assetId}: ${message}`);
      patchAsset(projectId, assetId, {
        cloudflare: { status: 'failed', progress: 0, lastError: message },
      });
    });
  });
}

export async function runCloudflareUpload(
  projectId: string,
  assetId: string,
  options?: CloudflareUploadOptions,
): Promise<void> {
  const asset = getAsset(projectId, assetId);
  if (!asset || !asset.filePath) {
    console.warn(`[cloudflare-publish] skipped upload for asset ${assetId}: asset or file path missing`);
    return;
  }

  // Verify the file is actually accessible before touching Cloudflare at all.
  // A missing file almost always means an external drive isn't mounted.
  if (!fs.existsSync(asset.filePath)) {
    const hint = asset.filePath.startsWith('/Volumes/')
      ? `File not found — the drive at ${asset.filePath.split('/').slice(0, 3).join('/')} may not be mounted.`
      : `File not found at: ${asset.filePath}`;
    console.error(`[cloudflare-publish] aborting upload for asset ${assetId}: ${hint}`);
    patchAsset(projectId, assetId, {
      cloudflare: { status: 'failed', progress: 0, lastError: hint },
    });
    return;
  }

  if (!canUploadToCloudflare()) {
    const diagnostic = getCloudflareStreamConfigDiagnostic();
    console.error(`[cloudflare-publish] config invalid for asset ${assetId}: ${diagnostic.message ?? 'unknown config error'}`);
    patchAsset(projectId, assetId, {
      cloudflare: {
        status: 'failed',
        lastError: diagnostic.message ?? 'Cloudflare Stream is not configured on this LPOS host.',
      },
    });
    return;
  }

  // Don't collide with an in-flight upload — our own, or a manual LeaderPass
  // publish that is mid-preparation (it drives the same CF video).
  if (
    asset.cloudflare.status === 'uploading' ||
    asset.cloudflare.status === 'processing' ||
    asset.leaderpass.status === 'preparing'
  ) {
    console.warn(`[cloudflare-publish] asset ${assetId} already has a CF upload in progress; skipping duplicate trigger`);
    return;
  }

  console.log(`[cloudflare-publish] starting upload for asset ${assetId} (${asset.originalFilename})`);

  // Capture the prior CF distribution BEFORE the 'uploading' patch creates a new
  // record. Otherwise getLatestDistributionInfoForAsset returns the just-made
  // (uid-null) uploading record and the old uid is never deleted on a version
  // replace. We also carry the custom poster forward (it lives in the prior
  // record's metadata_json and a new version starts a fresh record without it).
  const priorCloudflare = getLatestDistributionInfoForAsset(assetId, 'cloudflare');
  const priorPosterUrl  = readPriorPosterUrl(priorCloudflare);

  patchAsset(projectId, assetId, {
    cloudflare: { status: 'uploading', progress: 0, lastError: null, readyAt: null },
  });

  try {
    const prepared = await createCloudflareTusUpload(asset);
    console.log(`[cloudflare-publish] upload initialized for asset ${assetId}; uid=${prepared.uid}`);

    patchAsset(projectId, assetId, {
      cloudflare: { uid: prepared.uid, uploadUrl: prepared.uploadUrl, creator: asset.assetId },
    });

    // Lock allowed origins immediately — before any bytes are transferred.
    const allowedOrigins = options?.allowedOrigins ?? null;
    if (allowedOrigins && allowedOrigins.length > 0) {
      try {
        await applyVideoSettings(prepared.uid, { allowedOrigins });
        console.log(`[cloudflare-publish] allowedOrigins set for uid=${prepared.uid}`);
      } catch (err) {
        console.warn(`[cloudflare-publish] failed to set allowedOrigins for uid=${prepared.uid}:`, err);
      }
    }

    await uploadFileToCloudflareTus(prepared.uploadUrl, asset.filePath, {
      onProgress: (progress) => {
        patchAsset(projectId, assetId, { cloudflare: { progress } });
      },
    });

    console.log(`[cloudflare-publish] upload complete for asset ${assetId}; waiting for Cloudflare processing`);
    patchAsset(projectId, assetId, {
      cloudflare: { status: 'processing', progress: 100, uploadedAt: new Date().toISOString() },
    });

    const ready = await waitForCloudflareVideoReady(prepared.uid);
    console.log(`[cloudflare-publish] Cloudflare asset ready for ${assetId}; uid=${ready.uid}`);

    // Default thumbnail frame — probe fps fresh since it may not have been
    // stored at ingest. A custom poster (cloudflare.posterUrl, a Cloudflare
    // Images URL) is uid-independent and preserved automatically by the partial
    // patches below, so we never clobber it here.
    try {
      const targetFrame = CLOUDFLARE_DEFAULT_THUMBNAIL_FRAME;
      const { fps, duration } = await probeMediaInfo(asset.filePath);
      const effectiveDuration = asset.duration ?? duration;
      const pct = (fps != null && fps > 0 && effectiveDuration != null && effectiveDuration > 0)
        ? Math.max(0.001, Math.min(0.999, targetFrame / (fps * effectiveDuration)))
        : null;
      if (pct !== null) {
        await applyVideoSettings(prepared.uid, { thumbnailTimestampPct: pct });
        console.log(`[cloudflare-publish] thumbnailTimestampPct=${pct.toFixed(4)} (frame ${targetFrame}) set for uid=${prepared.uid}`);
      } else {
        console.warn(`[cloudflare-publish] could not compute thumbnailTimestampPct for uid=${prepared.uid} (fps=${fps}, duration=${effectiveDuration})`);
      }
    } catch (err) {
      console.warn(`[cloudflare-publish] failed to set thumbnailTimestampPct for uid=${prepared.uid}:`, err);
    }

    // Upload VTT captions if a completed transcript exists for this asset.
    if (asset.transcription.status === 'done' && asset.transcription.jobId) {
      try {
        const { vttPath } = getTranscriptPaths(projectId, asset.transcription.jobId);
        if (fs.existsSync(vttPath)) {
          await uploadCaptionsVtt(ready.uid, vttPath);
          console.log(`[cloudflare-publish] captions uploaded for uid=${ready.uid} (jobId=${asset.transcription.jobId})`);
        } else {
          console.warn(`[cloudflare-publish] VTT not found at ${vttPath}; skipping captions for uid=${ready.uid}`);
        }
      } catch (err) {
        console.warn(`[cloudflare-publish] failed to upload captions for uid=${ready.uid}:`, err);
      }
    }

    const readyAt = ready.readyAt ?? new Date().toISOString();
    patchAsset(projectId, assetId, {
      cloudflare: {
        uid: ready.uid,
        previewUrl: ready.previewUrl,
        thumbnailUrl: ready.thumbnailUrl,
        hlsUrl: ready.hlsUrl,
        dashUrl: ready.dashUrl,
        status: 'ready',
        progress: 100,
        readyAt,
        lastError: null,
        // Carry the custom poster forward to this version's fresh record so a
        // version replace doesn't silently drop the user's chosen thumbnail.
        // (posterUrl is a uid-independent Cloudflare Images URL.)
        ...(priorPosterUrl ? { posterUrl: priorPosterUrl } : {}),
      },
    });

    // Delete the prior Cloudflare video now that the new one is confirmed ready.
    // One retry on failure, then surface the orphan to the cloudflare_orphans
    // table for manual purge. Never block the flow on this.
    const oldCloudflareUid = priorCloudflare?.provider_asset_id ?? null;
    if (oldCloudflareUid && oldCloudflareUid !== ready.uid) {
      let lastErr: string | null = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await deleteCloudflareVideo(oldCloudflareUid);
          console.log(`[cloudflare-publish] deleted prior Cloudflare video uid=${oldCloudflareUid} for asset ${assetId} (attempt ${attempt})`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          console.warn(`[cloudflare-publish] failed to delete prior Cloudflare video uid=${oldCloudflareUid} (attempt ${attempt}):`, lastErr);
        }
      }
      if (lastErr) {
        try {
          recordOrphan({
            uid: oldCloudflareUid,
            assetId,
            projectId,
            reason: 'delete_failed',
            attempts: 2,
            lastError: lastErr,
          });
          console.warn(`[cloudflare-publish] recorded uid=${oldCloudflareUid} as Cloudflare orphan for manual purge`);
        } catch (recordErr) {
          console.error(`[cloudflare-publish] failed to record orphan uid=${oldCloudflareUid}:`, recordErr);
        }
      }
    }

    console.log(`[cloudflare-publish] asset ${assetId} uploaded to Cloudflare and ready`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cloudflare-publish] upload failed for asset ${assetId}: ${message}`);
    patchAsset(projectId, assetId, {
      cloudflare: { status: 'failed', progress: 0, lastError: message },
    });
  }
}
