/**
 * GET /api/projects/[projectId]/media/[assetId]/versions
 *
 * Returns every version of an asset with its Frame.io file id (if any)
 * and the local comment count for that version. Drives the Phase 3
 * sidebar version cycler in MediaDetailPanel — the UI fetches this once
 * when the panel opens, renders chips for each version, and uses
 * `commentCount` to badge the chips so users can see at-a-glance which
 * versions have feedback.
 *
 * Response shape:
 *   {
 *     versions: [
 *       {
 *         assetVersionId: "...",
 *         versionNumber:  3,
 *         createdAt:      "2026-06-09T...",
 *         frameioFileId:  "..." | null,
 *         commentCount:   12,
 *         isLatest:       true
 *       },
 *       ...
 *     ]
 *   }
 *
 * Sorted newest-first. The first entry is the latest version (isLatest:true).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAsset } from '@/lib/store/media-registry';
import { listAssetVersionsWithFrameioFileId } from '@/lib/store/canonical-asset-store';
import { getCommentCountsByVersion } from '@/lib/store/media-comment-store';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  try {
    const versions  = listAssetVersionsWithFrameioFileId(assetId);
    const countMap  = getCommentCountsByVersion(projectId, assetId);

    const enriched = versions.map((v, idx) => ({
      assetVersionId: v.assetVersionId,
      versionNumber:  v.versionNumber,
      createdAt:      v.createdAt,
      frameioFileId:  v.frameioFileId,
      commentCount:   countMap.get(v.assetVersionId) ?? 0,
      isLatest:       idx === 0,
    }));

    return NextResponse.json({ versions: enriched });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
