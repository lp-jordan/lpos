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
 * Reads from the local `media_comments` table. Identity model (decoupling
 * Step 3): `id` is ALWAYS the stable local comment_id; the Frame.io comment id
 * is a separate `frameioCommentId` field. EditPanel still tethers its Resolve
 * markers on the Frame.io id, so we (a) return only comments that have a
 * frameioCommentId, and (b) surface it explicitly.
 *
 * EDITPANEL FOLLOW-UP (deferred): the editpanel client currently reads `id`
 * for its `frameio:{id}` marker tag — it must switch to `frameioCommentId`.
 * Until it does, existing markers won't match (id is now comment_id). This is
 * the known, accepted break from the identity stabilization.
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

    // EditPanel can only tether markers on comments that exist in Frame.io, so
    // drop rows that were never mirrored (frameioCommentId === null). Then
    // resolve author names: LPOS-authored comments get their LPOS user's
    // current display name; external Frame.io reviewers keep the captured name.
    const named = comments
      .filter((c) => c.frameioCommentId != null)
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
