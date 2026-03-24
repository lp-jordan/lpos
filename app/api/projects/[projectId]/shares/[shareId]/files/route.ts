import { NextRequest, NextResponse } from 'next/server';
import { addFilesToShare } from '@/lib/services/frameio';
import { readRegistry } from '@/lib/store/media-registry';
import { addShareAssets } from '@/lib/store/share-assets-store';

type Params = { params: Promise<{ projectId: string; shareId: string }> };

/**
 * POST /api/projects/[projectId]/shares/[shareId]/files
 *
 * Body: { assetIds: string[] }
 *
 * Adds LPOS assets to an existing share (one Frame.io API call per asset)
 * and records the membership locally.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { projectId, shareId } = await params;
    const body = await req.json() as { assetIds?: string[] };

    const { assetIds = [] } = body;
    const assets = readRegistry(projectId);

    const fileIds: string[] = [];
    for (const assetId of assetIds) {
      const asset = assets.find((a) => a.assetId === assetId);
      if (asset?.frameio.assetId) fileIds.push(asset.frameio.assetId);
    }

    if (!fileIds.length) {
      return NextResponse.json({ error: 'No valid Frame.io files found for given assetIds' }, { status: 400 });
    }

    await addFilesToShare(shareId, fileIds);
    addShareAssets(projectId, shareId, fileIds);

    return NextResponse.json({ ok: true, added: fileIds.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
