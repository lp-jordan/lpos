import { NextRequest, NextResponse } from 'next/server';
import { deleteShare, renameShare } from '@/lib/services/frameio';
import { readRegistry } from '@/lib/store/media-registry';
import { getShareAssets, deleteShareRecord } from '@/lib/store/share-assets-store';

type Params = { params: Promise<{ projectId: string; shareId: string }> };

/**
 * GET /api/projects/[projectId]/shares/[shareId]
 *
 * Returns the files attached to a share from the local asset store,
 * enriched with LPOS display names.
 *
 * The Frame.io V4 API provides no endpoint to list share assets —
 * membership is tracked locally in share-assets-store.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { projectId, shareId } = await params;

    const fileIds = getShareAssets(projectId, shareId);
    const assets  = readRegistry(projectId);

    // Build name lookup: frameio file ID → LPOS asset
    const nameMap = new Map<string, { name: string; lposName: string }>();
    for (const a of assets) {
      if (a.frameio.assetId) {
        nameMap.set(a.frameio.assetId, { name: a.originalFilename, lposName: a.name });
      }
    }

    const files = fileIds.map((id) => {
      const entry = nameMap.get(id);
      return {
        id,
        name:     entry?.name     ?? id,
        lposName: entry?.lposName ?? null,
      };
    });

    return NextResponse.json({ files });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PATCH /api/projects/[projectId]/shares/[shareId]
 * Body: { name: string }
 *
 * Renames the share on Frame.io.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { shareId } = await params;
    const body = await req.json() as { name?: string };
    const name = body.name?.trim();
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    await renameShare(shareId, name);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/projects/[projectId]/shares/[shareId]
 *
 * Permanently deletes the share and removes its local asset record.
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { projectId, shareId } = await params;
    await deleteShare(shareId);
    deleteShareRecord(projectId, shareId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
