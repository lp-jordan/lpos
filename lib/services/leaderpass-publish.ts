import fs from 'node:fs';
import type { ActivityActor } from '@/lib/models/activity';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getUploadQueueService, getProjectStore } from '@/lib/services/container';
import { getLatestDistributionInfoForAsset } from '@/lib/store/canonical-asset-store';
import { recordActivity, serviceActor } from '@/lib/services/activity-monitor-service';
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

const CLOUDFLARE_ALLOWED_ORIGINS = ['app.leaderpass.com'];
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

export function triggerLeaderPassPublish(projectId: string, assetId: string, context?: LeaderPassPublishContext): void {
  setImmediate(() => {
    void runLeaderPassPublish(projectId, assetId, context).catch((error) => {
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
    });
  });
}

export function triggerLeaderPassBatchPublish(projectId: string, assetIds: string[]): void {
  for (const assetId of assetIds) {
    triggerLeaderPassPublish(projectId, assetId);
  }
}

async function runLeaderPassPublish(projectId: string, assetId: string, context?: LeaderPassPublishContext): Promise<void> {
  const asset = getAsset(projectId, assetId);
  if (!asset || !asset.filePath) {
    console.warn(`[leaderpass] skipped publish for asset ${assetId}: asset or file path missing`);
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

  const alreadyActive = asset.leaderpass.status === 'preparing'
    && (asset.cloudflare.uid !== null || asset.cloudflare.uploadUrl !== null || asset.cloudflare.progress > 0);
  const cloudflareProcessing = asset.cloudflare.status === 'processing';

  if (alreadyActive || cloudflareProcessing) {
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

  try {
    const fileSize = asset.fileSize ?? getCloudflareFileSize(asset.filePath);
    const priorCloudflare = getLatestDistributionInfoForAsset(assetId, 'cloudflare');
    const priorLeaderPass = getLatestDistributionInfoForAsset(assetId, 'leaderpass');
    console.log(`[leaderpass] creating Cloudflare upload for asset ${assetId} (${fileSize} bytes)`);
    const prepared = await createCloudflareTusUpload(asset);
    console.log(`[leaderpass] Cloudflare upload initialized for asset ${assetId}; uid=${prepared.uid}`);

    patchAsset(projectId, assetId, {
      cloudflare: {
        uid: prepared.uid,
        uploadUrl: prepared.uploadUrl,
        creator: asset.assetId,
      },
    });

    // Lock allowed origins immediately — before any bytes are transferred.
    try {
      await applyVideoSettings(prepared.uid, { allowedOrigins: CLOUDFLARE_ALLOWED_ORIGINS });
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

    const ready = await waitForCloudflareVideoReady(prepared.uid, {
      isCancelled: jobId ? () => queue?.isCancelled(jobId) ?? false : undefined,
    });
    console.log(`[leaderpass] Cloudflare asset ready for ${assetId}; uid=${ready.uid}`);

    // Set thumbnail frame — probe fps fresh since it may not have been stored at ingest.
    // Use per-project configured frame number as the target, falling back to the global default.
    if (asset.filePath) {
      try {
        const project = getProjectStore().getById(projectId);
        const targetFrame = project?.cloudflareDefaults?.thumbnailFrameNumber ?? CLOUDFLARE_DEFAULT_THUMBNAIL_FRAME;
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
    const oldCloudflareUid = priorCloudflare?.provider_asset_id ?? null;
    if (oldCloudflareUid && oldCloudflareUid !== ready.uid) {
      try {
        await deleteCloudflareVideo(oldCloudflareUid);
        console.log(`[leaderpass] deleted prior Cloudflare video uid=${oldCloudflareUid} for asset ${assetId}`);
      } catch (err) {
        console.warn(`[leaderpass] failed to delete prior Cloudflare video uid=${oldCloudflareUid}:`, err);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = message === 'Cancelled';
    console.error(`[leaderpass] publish failed for asset ${assetId}: ${message}`);

    patchAsset(projectId, assetId, {
      cloudflare: {
        status: cancelled ? 'none' : 'failed',
        progress: 0,
        lastError: cancelled ? null : message,
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
