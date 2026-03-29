import { NextRequest, NextResponse } from 'next/server';
import { getAssetShareLinks, removeAssetShareLink } from '@/lib/store/asset-share-links-store';
import { deleteShareRecord } from '@/lib/store/share-assets-store';

type Params = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * GET /api/projects/[projectId]/media/[assetId]/shares
 *
 * Returns all share links that have been generated for this asset.
 */
export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  const { projectId, assetId } = await params;
  const shares = getAssetShareLinks(projectId, assetId);
  return NextResponse.json({ shares });
}

/**
 * DELETE /api/projects/[projectId]/media/[assetId]/shares?shareId=xxx
 *
 * Removes a share link from the asset's record (does not delete it from Frame.io).
 */
export async function DELETE(
  req: NextRequest,
  { params }: Params,
) {
  const { projectId, assetId } = await params;
  const shareId = new URL(req.url).searchParams.get('shareId');
  if (!shareId) return NextResponse.json({ error: 'shareId is required' }, { status: 400 });

  removeAssetShareLink(projectId, assetId, shareId);
  deleteShareRecord(projectId, shareId);

  return NextResponse.json({ ok: true });
}
