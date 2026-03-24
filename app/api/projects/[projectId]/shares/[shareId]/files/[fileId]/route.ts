import { NextRequest, NextResponse } from 'next/server';
import { removeFileFromShare } from '@/lib/services/frameio';
import { removeShareAsset } from '@/lib/store/share-assets-store';

type Params = { params: Promise<{ projectId: string; shareId: string; fileId: string }> };

/**
 * DELETE /api/projects/[projectId]/shares/[shareId]/files/[fileId]
 *
 * Removes a single asset from a share and updates the local store.
 * fileId is the Frame.io asset ID (asset.frameio.assetId).
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { projectId, shareId, fileId } = await params;
    await removeFileFromShare(shareId, fileId);
    removeShareAsset(projectId, shareId, fileId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
