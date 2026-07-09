import { NextRequest, NextResponse } from 'next/server';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getCloudflareStreamConfigDiagnostic, getCloudflareVideoState } from '@/lib/services/cloudflare-stream';
import { resolveRequestActor } from '@/lib/services/activity-actor';
import { canPrepareLeaderPassPublish, triggerLeaderPassPublish } from '@/lib/services/leaderpass-publish';
import { pruneCloudflareVersionsForAsset } from '@/lib/services/cloudflare-publish';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  return NextResponse.json({ leaderpass: asset.leaderpass, cloudflare: asset.cloudflare });
}

export async function POST(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const actor = resolveRequestActor(_req);
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  if (!asset.filePath) {
    return NextResponse.json({ error: 'No local file path — cannot prepare LeaderPass delivery.' }, { status: 400 });
  }

  if (!canPrepareLeaderPassPublish()) {
    const diagnostic = getCloudflareStreamConfigDiagnostic();
    patchAsset(projectId, assetId, {
      leaderpass: {
        status: 'failed',
        lastError: diagnostic.message ?? 'Cloudflare Stream credentials are not configured on this LPOS host.',
      },
    });
    return NextResponse.json({ error: diagnostic.message ?? 'Cloudflare Stream is not configured on this LPOS host.' }, { status: 501 });
  }

  if (asset.leaderpass.status === 'preparing' || asset.cloudflare.status === 'uploading' || asset.cloudflare.status === 'processing') {
    return NextResponse.json({ error: 'LeaderPass publish is already in progress.' }, { status: 409 });
  }

  patchAsset(projectId, assetId, {
    leaderpass: { status: 'preparing', lastError: null },
    cloudflare: { status: 'uploading', progress: 0, lastError: null },
  });
  triggerLeaderPassPublish(projectId, assetId, { actor });

  return NextResponse.json({ ok: true, status: 'preparing' });
}

/**
 * Force reset. Historically this only blanked LPOS's local Cloudflare pointer,
 * silently orphaning the real CF video(s) in the account. It now forcefully
 * collapses the asset's Cloudflare footprint to a single live video:
 *
 *  - If a most-recent, confirmed-live (readyToStream) CF video exists, every
 *    OTHER CF video for this asset is deleted and LPOS is repointed at the
 *    survivor (leaving the embed working). This is the "clean up duplicates,
 *    keep the live one" case.
 *  - If no CF video is confirmed live (e.g. a stuck/half-finished upload with no
 *    prior good version), nothing is deleted and local state is wiped to `none`
 *    so the operator can re-push from scratch — the original reset behaviour.
 */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  let prune: Awaited<ReturnType<typeof pruneCloudflareVersionsForAsset>> | null = null;
  try {
    prune = await pruneCloudflareVersionsForAsset(assetId, { preferUid: asset.cloudflare.uid ?? null });
  } catch (err) {
    console.warn(`[leaderpass] Cloudflare prune failed during reset for ${assetId}:`, err);
  }

  // A live survivor remains → repoint LPOS at it rather than blanking state.
  if (prune?.keptUid) {
    let updated = getAsset(projectId, assetId);
    try {
      const survivor = await getCloudflareVideoState(prune.keptUid);
      updated = patchAsset(projectId, assetId, {
        cloudflare: {
          uid: survivor.uid,
          uploadUrl: null,
          previewUrl: survivor.previewUrl,
          hlsUrl: survivor.hlsUrl,
          dashUrl: survivor.dashUrl,
          status: 'ready',
          progress: 100,
          uploadedAt: survivor.uploadedAt ?? asset.cloudflare.uploadedAt ?? null,
          readyAt: survivor.readyAt ?? asset.cloudflare.readyAt ?? new Date().toISOString(),
          lastError: null,
        },
      });
    } catch (err) {
      console.warn(`[leaderpass] failed to repoint asset ${assetId} at survivor ${prune.keptUid}:`, err);
    }
    console.log(`[leaderpass] reset collapsed asset ${assetId} to live CF uid=${prune.keptUid}; deleted ${prune.deletedUids.length} stale video(s)`);
    return NextResponse.json({ ok: true, asset: updated, prune });
  }

  // No confirmed-live survivor → wipe local state for a clean re-push.
  const updated = patchAsset(projectId, assetId, {
    cloudflare: {
      uid: null,
      uploadUrl: null,
      previewUrl: null,
      thumbnailUrl: null,
      hlsUrl: null,
      dashUrl: null,
      status: 'none',
      progress: 0,
      uploadedAt: null,
      readyAt: null,
      creator: null,
      lastError: null,
    },
    leaderpass: {
      status: 'none',
      contentId: null,
      tileId: null,
      playbackUrl: null,
      thumbnailUrl: null,
      lastPreparedAt: null,
      publishedAt: null,
      lastError: null,
      pendingPayload: null,
    },
  });

  console.log(`[leaderpass] reset publish state for asset ${assetId}${prune ? ` (prune skipped: ${prune.reason ?? 'no live survivor'})` : ''}`);
  return NextResponse.json({ ok: true, asset: updated, prune });
}
