import { NextRequest, NextResponse } from 'next/server';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getCloudflareStreamConfigDiagnostic } from '@/lib/services/cloudflare-stream';
import { canPrepareLeaderPassPublish, triggerLeaderPassPublish } from '@/lib/services/leaderpass-publish';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  return NextResponse.json({ leaderpass: asset.leaderpass, cloudflare: asset.cloudflare });
}

export async function POST(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
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
  triggerLeaderPassPublish(projectId, assetId);

  return NextResponse.json({ ok: true, status: 'preparing' });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

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

  console.log(`[leaderpass] reset publish state for asset ${assetId}`);
  return NextResponse.json({ ok: true, asset: updated });
}
