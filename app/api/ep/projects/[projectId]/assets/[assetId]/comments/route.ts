import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getAsset } from '@/lib/store/media-registry';
import { findAssetVersionByFrameioFileId } from '@/lib/store/canonical-asset-store';
import { getThreadedCommentsForAssetVersion } from '@/lib/store/media-comment-store';
import { getUserById } from '@/lib/store/user-store';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * GET /api/ep/projects/:projectId/assets/:assetId/comments
 *
 * Returns comments for an asset, with author names resolved. EditPanel uses
 * these to place review markers on the source Resolve timeline (tagged
 * `frameio:{id}` per locked decision §11 #4 — tether stays through Phase 4).
 *
 * Phase 1: reads from the local `media_comments` table instead of Frame.io.
 * Returned shape is unchanged so editpanel doesn't notice the swap. `id`
 * field returns the Frame.io comment id when present (preserves the marker
 * tether); comments without a Frame.io id (e.g. abandoned mirror jobs) get
 * filtered so editpanel never sees a stale marker reference.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const fileId = asset.frameio?.assetId;
  if (!fileId) {
    return NextResponse.json({ comments: [] });
  }

  try {
    const mapping = findAssetVersionByFrameioFileId(fileId);
    if (!mapping) {
      return NextResponse.json({ comments: [] });
    }

    const { comments, rowLookup } = getThreadedCommentsForAssetVersion(
      mapping.projectId,
      mapping.assetId,
      mapping.assetVersionId,
    );

    // Resolve author names: LPOS-authored comments get their LPOS user's
    // current display name; external Frame.io reviewers keep the name we
    // captured. Then filter out comments without a Frame.io id — editpanel
    // addresses comments via `frameio:{id}` so it never sees rows that
    // haven't been mirrored. The store's id-fallback to local comment_id
    // surfaces unmirrored rows; here we drop them.
    const named = comments
      .filter((c) => {
        const lookup = rowLookup.get(c.id);
        // Drop if this is a local-only row (no Frame.io id). The lookup's
        // commentId matching c.id means c.id IS the local comment_id, not a
        // Frame.io id — those rows are invisible to editpanel.
        return !lookup || lookup.commentId !== c.id;
      })
      .map((c) => {
        const lookup = rowLookup.get(c.id);
        const lposUser = lookup?.authorUserId ? getUserById(lookup.authorUserId) : null;
        return { ...c, authorName: lposUser?.name ?? c.authorName };
      });

    return NextResponse.json({ comments: named });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
