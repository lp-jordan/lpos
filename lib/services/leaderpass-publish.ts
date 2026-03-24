import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getUploadQueueService } from '@/lib/services/container';
import { getLatestDistributionInfoForAsset } from '@/lib/store/canonical-asset-store';
import {
  createCloudflareTusUpload,
  getCloudflareStreamConfigDiagnostic,
  getCloudflareFileSize,
  isCloudflareStreamConfigured,
  uploadFileToCloudflareTus,
  waitForCloudflareVideoReady,
} from '@/lib/services/cloudflare-stream';

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

export function triggerLeaderPassPublish(projectId: string, assetId: string): void {
  setImmediate(() => {
    void runLeaderPassPublish(projectId, assetId).catch((error) => {
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

async function runLeaderPassPublish(projectId: string, assetId: string): Promise<void> {
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
    queue?.setProgress(jobId!, 100);

    const ready = await waitForCloudflareVideoReady(prepared.uid, {
      isCancelled: jobId ? () => queue?.isCancelled(jobId) ?? false : undefined,
    });
    console.log(`[leaderpass] Cloudflare asset ready for ${assetId}; uid=${ready.uid}`);

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

    queue?.complete(jobId!);
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
  }
}
