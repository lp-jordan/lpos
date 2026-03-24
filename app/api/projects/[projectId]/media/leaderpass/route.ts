import { NextRequest, NextResponse } from 'next/server';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getCloudflareStreamConfigDiagnostic } from '@/lib/services/cloudflare-stream';
import { canPrepareLeaderPassPublish, triggerLeaderPassBatchPublish } from '@/lib/services/leaderpass-publish';

type Ctx = { params: Promise<{ projectId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId } = await params;
  const body = await req.json() as { assetIds?: string[] };
  const assetIds = Array.isArray(body.assetIds) ? body.assetIds.filter(Boolean) : [];

  if (assetIds.length === 0) {
    return NextResponse.json({ error: 'assetIds is required' }, { status: 400 });
  }

  if (!canPrepareLeaderPassPublish()) {
    const diagnostic = getCloudflareStreamConfigDiagnostic();
    return NextResponse.json({ error: diagnostic.message ?? 'Cloudflare Stream is not configured on this LPOS host.' }, { status: 501 });
  }

  const readyIds: string[] = [];
  const skipped: Array<{ assetId: string; reason: string }> = [];

  for (const assetId of assetIds) {
    const asset = getAsset(projectId, assetId);
    if (!asset) {
      skipped.push({ assetId, reason: 'Asset not found' });
      continue;
    }
    if (!asset.filePath) {
      skipped.push({ assetId, reason: 'Asset has no local file path' });
      continue;
    }
    if (asset.leaderpass.status === 'preparing' || asset.cloudflare.status === 'uploading' || asset.cloudflare.status === 'processing') {
      skipped.push({ assetId, reason: 'Publish already in progress' });
      continue;
    }

    patchAsset(projectId, assetId, {
      leaderpass: { status: 'preparing', lastError: null },
      cloudflare: { status: 'uploading', progress: 0, lastError: null },
    });
    readyIds.push(assetId);
  }

  if (readyIds.length > 0) {
    triggerLeaderPassBatchPublish(projectId, readyIds);
  }

  return NextResponse.json({
    ok: true,
    queued: readyIds.length,
    skipped,
  });
}
