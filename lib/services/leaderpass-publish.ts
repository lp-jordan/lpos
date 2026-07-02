import fs from 'node:fs';
import type { ActivityActor } from '@/lib/models/activity';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getUploadQueueService } from '@/lib/services/container';
import { getLatestDistributionInfoForAsset } from '@/lib/store/canonical-asset-store';
import { recordOrphan } from '@/lib/store/cloudflare-orphan-store';
import { recordActivity, serviceActor } from '@/lib/services/activity-monitor-service';
import { probeMediaInfo } from '@/lib/services/media-probe';
import { getTranscriptPaths } from '@/lib/transcripts/store';
import { triggerAutoProvisionOnFinalize } from '@/lib/services/lpai-provisioning';
import {
  applyVideoSettings,
  createCloudflareTusUpload,
  deleteCloudflareVideo,
  getCloudflareStreamConfigDiagnostic,
  getCloudflareFileSize,
  getDefaultAllowedOrigins,
  isCloudflareStreamConfigured,
  uploadCaptionsVtt,
  uploadFileToCloudflareTus,
  waitForCloudflareVideoReady,
} from '@/lib/services/cloudflare-stream';

const CLOUDFLARE_DEFAULT_THUMBNAIL_FRAME = 24;

type PublishQueueProvider = 'frameio' | 'leaderpass';

function getQueue() {
  try {
    return getUploadQueueService();
  } catch {
    return null;
  }
}

export function canPrepareLeaderPassPublish(): boolean {
  return isCloudflareStreamConfigured();
}

interface LeaderPassPublishContext {
  actor?: ActivityActor;
}

// How many assets upload to Cloudflare at once from a batch push. Firing all of
// them concurrently saturates the uplink and Cloudflare's connection pool, which
// itself triggers 'fetch failed' socket resets mid-upload. A small pool keeps the
// batch moving without stampeding. Override via env if a host has more headroom.
const MAX_CONCURRENT_PUBLISH = Math.max(1, Number(process.env.LEADERPASS_MAX_CONCURRENT_PUBLISH ?? 3));

async function runLeaderPassPublishSafe(
  projectId: string,
  assetId: string,
  context?: LeaderPassPublishContext,
): Promise<void> {
  try {
    await runLeaderPassPublish(projectId, assetId, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[leaderpass] unhandled publish failure for asset ${assetId}: ${message}`);
    patchAsset(projectId, assetId, {
      cloudflare: {
        status: 'failed',
        progress: 0,
        lastError: message,
      },
      leaderpass: {
        status: 'failed',
        lastError: message,
      },
    });
  }
}

export function triggerLeaderPassPublish(projectId: string, assetId: string, context?: LeaderPassPublishContext): void {
  setImmediate(() => {
    void runLeaderPassPublishSafe(projectId, assetId, context);
  });
}

export function triggerLeaderPassBatchPublish(projectId: string, assetIds: string[]): void {
  // Drain the asset list with a bounded worker pool rather than firing every
  // upload at once. Each worker pulls the next asset when its current one settles.
  const queue = [...assetIds];
  const runNext = async (): Promise<void> => {
    const assetId = queue.shift();
    if (assetId === undefined) return;
    await runLeaderPassPublishSafe(projectId, assetId);
    await runNext();
  };
  const workerCount = Math.min(MAX_CONCURRENT_PUBLISH, queue.length);
  for (let i = 0; i < workerCount; i += 1) {
    void runNext();
  }
}

async function runLeaderPassPublish(projectId: string, assetId: string, context?: LeaderPassPublishContext): Promise<void> {
  const asset = getAsset(projectId, assetId);
  if (!asset || !asset.filePath) {
    console.warn(`[leaderpass] skipped publish for asset ${assetId}: asset or file path missing`);
    return;
  }

  // Verify the file is actually accessible before touching Cloudflare at all.
  // A missing file almost always means an external drive isn't mounted.
  if (!fs.existsSync(asset.filePath)) {
    const hint = asset.filePath.startsWith('/Volumes/')
      ? `File not found — the drive at ${asset.filePath.split('/').slice(0, 3).join('/')} may not be mounted.`
      : `File not found at: ${asset.filePath}`;
    console.error(`[leaderpass] aborting publish for asset ${assetId}: ${hint}`);
    patchAsset(projectId, assetId, {
      cloudflare: { status: 'failed', progress: 0, lastError: hint },
      leaderpass: { status: 'failed', lastError: hint },
    });
    return;
  }

  console.log(`[leaderpass] starting publish for asset ${assetId} (${asset.originalFilename})`);

  if (!canPrepareLeaderPassPublish()) {
    const diagnostic = getCloudflareStreamConfigDiagnostic();
    console.error(`[leaderpass] config invalid for asset ${assetId}: ${diagnostic.message ?? 'unknown config error'}`);
    patchAsset(projectId, assetId, {
      leaderpass: {
        status: 'failed',
        lastError: diagnostic.message ?? 'Cloudflare Stream is not configured on this LPOS host.',
      },
    });
    return;
  }

  // Real evidence that an upload is genuinely in flight, as opposed to a bare
  // pre-flight 'uploading' claim written by the publish API route just before it
  // dispatches to this worker (that claim carries no uid/uploadUrl and 0 progress).
  const hasUploadEvidence = asset.cloudflare.uid !== null
    || asset.cloudflare.uploadUrl !== null
    || asset.cloudflare.progress > 0;
  const alreadyActive = asset.leaderpass.status === 'preparing' && hasUploadEvidence;
  // 'uploading' WITH evidence means a decoupled CF auto-upload (or another publish)
  // is genuinely mid-flight, so a manual push must not collide with it. A bare
  // 'uploading' with no evidence is just this request's own route-set claim — let
  // it through, otherwise the worker rejects the very state the route set for it
  // and the asset wedges at uploading/preparing forever (regression from 4cae2ca).
  const cloudflareBusy = asset.cloudflare.status === 'processing'
    || (asset.cloudflare.status === 'uploading' && hasUploadEvidence);

  if (alreadyActive || cloudflareBusy) {
    console.warn(`[leaderpass] asset ${assetId} is already in progress; skipping duplicate trigger`);
    return;
  }

  const queue = getQueue();
  const filename = asset.name || asset.originalFilename;
  const jobId = queue?.add(projectId, assetId, filename, 'leaderpass' satisfies PublishQueueProvider) ?? null;
  const actor = context?.actor ?? serviceActor('LeaderPass Publish', 'leaderpass-publish');

  recordActivity({
    ...actor,
    occurred_at: new Date().toISOString(),
    event_type: 'leaderpass.publish.queued',
    lifecycle_phase: 'queued',
    source_kind: 'background_service',
    visibility: 'user_timeline',
    title: `LeaderPass publish queued: ${filename}`,
    summary: `${filename} was queued for LeaderPass preparation`,
    project_id: projectId,
    asset_id: assetId,
    job_id: jobId,
    source_service: 'leaderpass-publish',
    details_json: { filename },
  });

  patchAsset(projectId, assetId, {
    cloudflare: {
      status: 'uploading',
      progress: 0,
      lastError: null,
      readyAt: null,
    },
    leaderpass: {
      status: 'preparing',
      lastError: null,
      publishedAt: null,
    },
  });
  recordActivity({
    ...actor,
    occurred_at: new Date().toISOString(),
    event_type: 'leaderpass.publish.started',
    lifecycle_phase: 'running',
    source_kind: 'background_service',
    visibility: 'user_timeline',
    title: `LeaderPass publish started: ${filename}`,
    summary: `${filename} started Cloudflare and LeaderPass preparation`,
    project_id: projectId,
    asset_id: assetId,
    job_id: jobId,
    source_service: 'leaderpass-publish',
    details_json: { filename },
  });

  // Hoisted so the catch block can clean up the Cloudflare-side video when the
  // user cancels mid-upload — otherwise the half-uploaded (or fully-uploaded,
  // not-yet-publish-ready) Stream video lingers on the CF account as a true
  // orphan that nothing in LPOS knows about. See catch branch below.
  let prepared: { uid: string; uploadUrl: string } | null = null;
  try {
    const fileSize = asset.fileSize ?? getCloudflareFileSize(asset.filePath);
    const priorCloudflare = getLatestDistributionInfoForAsset(assetId, 'cloudflare');
    const priorLeaderPass = getLatestDistributionInfoForAsset(assetId, 'leaderpass');
    console.log(`[leaderpass] creating Cloudflare upload for asset ${assetId} (${fileSize} bytes)`);
    prepared = await createCloudflareTusUpload(asset);
    console.log(`[leaderpass] Cloudflare upload initialized for asset ${assetId}; uid=${prepared.uid}`);

    patchAsset(projectId, assetId, {
      cloudflare: {
        uid: prepared.uid,
        uploadUrl: prepared.uploadUrl,
        creator: asset.assetId,
      },
    });

    // Lock allowed origins immediately — before any bytes are transferred.
    // Shared default (LPOS host + platform) so manually-pushed videos are also
    // playable by the in-app CF player, not just the LeaderPass platform.
    try {
      await applyVideoSettings(prepared.uid, { allowedOrigins: getDefaultAllowedOrigins() });
      console.log(`[leaderpass] allowedOrigins set for uid=${prepared.uid}`);
    } catch (err) {
      console.warn(`[leaderpass] failed to set allowedOrigins for uid=${prepared.uid}:`, err);
    }

    queue?.setProgress(jobId!, 0);
    console.log(`[leaderpass] uploading asset ${assetId} to Cloudflare via tus`);

    await uploadFileToCloudflareTus(prepared.uploadUrl, asset.filePath, {
      onProgress: (progress) => {
        queue?.setProgress(jobId!, progress);
        patchAsset(projectId, assetId, {
          cloudflare: { progress },
        });
      },
      isCancelled: jobId ? () => queue?.isCancelled(jobId) ?? false : undefined,
    });

    console.log(`[leaderpass] upload complete for asset ${assetId}; waiting for Cloudflare processing`);

    patchAsset(projectId, assetId, {
      cloudflare: {
        status: 'processing',
        progress: 100,
        uploadedAt: new Date().toISOString(),
      },
    });
    queue?.setProcessing(jobId!, 'Waiting for Cloudflare Stream processing');

    // Heartbeat the upload-queue job during the Cloudflare ready-poll wait so the
    // stale-job sweep doesn't auto-fail us while CF is legitimately encoding. The
    // sweep tolerates ~25 min for 'processing'; we tick every 60s to stay well clear.
    const heartbeatTimer = jobId
      ? setInterval(() => queue?.heartbeat(jobId), 60_000)
      : null;
    let ready;
    try {
      ready = await waitForCloudflareVideoReady(prepared.uid, {
        isCancelled: jobId ? () => queue?.isCancelled(jobId) ?? false : undefined,
      });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
    console.log(`[leaderpass] Cloudflare asset ready for ${assetId}; uid=${ready.uid}`);

    // Set thumbnail frame — probe fps fresh since it may not have been stored at ingest.
    // Hardcoded to CLOUDFLARE_DEFAULT_THUMBNAIL_FRAME (24); the per-project override was retired
    // because users overwhelmingly replace the auto-thumbnail with a custom image from the
    // sidebar uploader (BatchSetThumbnailModal → Cloudflare Images → asset.cloudflare.posterUrl).
    if (asset.filePath) {
      try {
        const targetFrame = CLOUDFLARE_DEFAULT_THUMBNAIL_FRAME;
        const { fps, duration } = await probeMediaInfo(asset.filePath);
        const effectiveDuration = asset.duration ?? duration;
        const pct = (fps != null && fps > 0 && effectiveDuration != null && effectiveDuration > 0)
          ? Math.max(0.001, Math.min(0.999, targetFrame / (fps * effectiveDuration)))
          : null;
        if (pct !== null) {
          await applyVideoSettings(prepared.uid, { thumbnailTimestampPct: pct });
          console.log(`[leaderpass] thumbnailTimestampPct=${pct.toFixed(4)} (frame ${targetFrame}) set for uid=${prepared.uid}`);
        } else {
          console.warn(`[leaderpass] could not compute thumbnailTimestampPct for uid=${prepared.uid} (fps=${fps}, duration=${effectiveDuration})`);
        }
      } catch (err) {
        console.warn(`[leaderpass] failed to set thumbnailTimestampPct for uid=${prepared.uid}:`, err);
      }
    }

    // Upload VTT captions if a completed transcript exists for this asset.
    if (asset.transcription.status === 'done' && asset.transcription.jobId) {
      try {
        const { vttPath } = getTranscriptPaths(projectId, asset.transcription.jobId);
        if (fs.existsSync(vttPath)) {
          await uploadCaptionsVtt(ready.uid, vttPath);
          console.log(`[leaderpass] captions uploaded for uid=${ready.uid} (jobId=${asset.transcription.jobId})`);
        } else {
          console.warn(`[leaderpass] VTT not found at ${vttPath}; skipping captions for uid=${ready.uid}`);
        }
      } catch (err) {
        console.warn(`[leaderpass] failed to upload captions for uid=${ready.uid}:`, err);
      }
    }

    const preparedAt = new Date().toISOString();
    patchAsset(projectId, assetId, {
      cloudflare: {
        uid: ready.uid,
        previewUrl: ready.previewUrl,
        thumbnailUrl: ready.thumbnailUrl,
        hlsUrl: ready.hlsUrl,
        dashUrl: ready.dashUrl,
        status: 'ready',
        progress: 100,
        readyAt: ready.readyAt ?? preparedAt,
        lastError: null,
      },
      leaderpass: {
        status: 'awaiting_platform',
        playbackUrl: ready.previewUrl,
        thumbnailUrl: ready.thumbnailUrl,
        lastPreparedAt: preparedAt,
        lastError: null,
        pendingPayload: {
          assetId: asset.assetId,
          projectId: asset.projectId,
          title: asset.name,
          description: asset.description,
          tags: asset.tags,
          mimeType: asset.mimeType,
          fileSize,
          sourcePath: asset.filePath,
          cloudflareStreamUid: ready.uid,
        playbackUrl: ready.previewUrl,
        thumbnailUrl: ready.thumbnailUrl,
        preparedAt,
        replaceExistingCloudflareUid: priorCloudflare?.provider_asset_id ?? null,
        replaceExistingLeaderPassContentId: priorLeaderPass?.provider_asset_id ?? null,
        replaceExistingLeaderPassTileId: priorLeaderPass?.provider_parent_id ?? null,
      },
    },
  });

    // Delete the prior Cloudflare video now that the new one is confirmed ready.
    // One retry on failure, then surface the orphan to the cloudflare_orphans table
    // so the user can purge it manually later. Never block the publish flow on this.
    const oldCloudflareUid = priorCloudflare?.provider_asset_id ?? null;
    if (oldCloudflareUid && oldCloudflareUid !== ready.uid) {
      let lastErr: string | null = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await deleteCloudflareVideo(oldCloudflareUid);
          console.log(`[leaderpass] deleted prior Cloudflare video uid=${oldCloudflareUid} for asset ${assetId} (attempt ${attempt})`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          console.warn(`[leaderpass] failed to delete prior Cloudflare video uid=${oldCloudflareUid} (attempt ${attempt}):`, lastErr);
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
          console.warn(`[leaderpass] recorded uid=${oldCloudflareUid} as Cloudflare orphan for manual purge`);
        } catch (recordErr) {
          console.error(`[leaderpass] failed to record orphan uid=${oldCloudflareUid}:`, recordErr);
        }
      }
    }

    queue?.complete(jobId!);
    recordActivity({
      ...actor,
      occurred_at: new Date().toISOString(),
      event_type: 'leaderpass.publish.completed',
      lifecycle_phase: 'completed',
      source_kind: 'background_service',
      visibility: 'user_timeline',
      title: `LeaderPass publish prepared: ${filename}`,
      summary: `${filename} is ready for LeaderPass handoff`,
      project_id: projectId,
      asset_id: assetId,
      job_id: jobId,
      source_service: 'leaderpass-publish',
      details_json: {
        filename,
        playbackUrl: ready.previewUrl,
        cloudflareUid: ready.uid,
      },
    });
    console.log(`[leaderpass] asset ${assetId} prepared for LeaderPass handoff`);

    // Auto-provision to LeaderPass AI if this project is toggled on. This is the
    // first moment the asset has a Cloudflare UID (which LP.AI's ingest contract
    // requires), so it's the natural "video finalized" hook. No-op when the
    // toggle is off or LP.AI is unconfigured. Never blocks the publish flow.
    triggerAutoProvisionOnFinalize(projectId, assetId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = message === 'Cancelled';
    console.error(`[leaderpass] publish failed for asset ${assetId}: ${message}`);

    // On cancel, delete the Cloudflare-side video so we don't leave a half-
    // uploaded (or fully-uploaded, awaiting-encode) orphan on the CF account.
    // The asset record's cloudflare.uid is also cleared so a re-push isn't
    // confused by a dead reference (and the stale-version dot can't trip on
    // an unfindable uid). One retry, then record to cloudflare_orphans so an
    // admin can purge it later — never block the cancel return path on this.
    if (cancelled && prepared?.uid) {
      const orphanUid = prepared.uid;
      let lastErr: string | null = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await deleteCloudflareVideo(orphanUid);
          console.log(`[leaderpass] deleted cancelled Cloudflare video uid=${orphanUid} for asset ${assetId} (attempt ${attempt})`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          console.warn(`[leaderpass] failed to delete cancelled Cloudflare video uid=${orphanUid} (attempt ${attempt}):`, lastErr);
        }
      }
      if (lastErr) {
        try {
          recordOrphan({
            uid: orphanUid,
            assetId,
            projectId,
            name: filename,
            reason: 'delete_failed',
            attempts: 2,
            lastError: `cancel: ${lastErr}`,
          });
          console.warn(`[leaderpass] recorded cancelled uid=${orphanUid} as Cloudflare orphan for manual purge`);
        } catch (recordErr) {
          console.error(`[leaderpass] failed to record cancel-orphan uid=${orphanUid}:`, recordErr);
        }
      }
    }

    patchAsset(projectId, assetId, {
      cloudflare: {
        status: cancelled ? 'none' : 'failed',
        progress: 0,
        lastError: cancelled ? null : message,
        // Clear the dead uid/uploadUrl on cancel so the next publish creates a
        // fresh CF video instead of trying to resume a torn-down upload.
        ...(cancelled ? { uid: null, uploadUrl: null } : {}),
      },
      leaderpass: {
        status: cancelled ? 'none' : 'failed',
        lastError: cancelled ? null : message,
      },
    });

    if (jobId) {
      if (cancelled) queue?.cancel(jobId);
      else queue?.fail(jobId, message);
    }
    recordActivity({
      ...actor,
      occurred_at: new Date().toISOString(),
      event_type: cancelled ? 'leaderpass.publish.cancelled' : 'leaderpass.publish.failed',
      lifecycle_phase: cancelled ? 'cancelled' : 'failed',
      source_kind: 'background_service',
      visibility: cancelled ? 'operator_only' : 'user_timeline',
      title: `${cancelled ? 'LeaderPass publish cancelled' : 'LeaderPass publish failed'}: ${filename}`,
      summary: cancelled
        ? `${filename} LeaderPass preparation was cancelled`
        : `${filename} failed during LeaderPass preparation`,
      project_id: projectId,
      asset_id: assetId,
      job_id: jobId,
      source_service: 'leaderpass-publish',
      details_json: { filename, error: cancelled ? null : message },
    });
  }
}
