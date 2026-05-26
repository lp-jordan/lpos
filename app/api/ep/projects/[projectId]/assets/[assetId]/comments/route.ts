import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getAsset } from '@/lib/store/media-registry';
import { getComments } from '@/lib/services/frameio';
import { getCommentAuthor } from '@/lib/store/comment-authors-store';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * GET /api/ep/projects/:projectId/assets/:assetId/comments
 *
 * Returns Frame.io comments for an asset, with author names resolved.
 * EditPanel uses these to place review markers on the source Resolve timeline.
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
    const comments = await getComments(fileId);
    const named = comments.map((c) => {
      const entry = getCommentAuthor(projectId, c.id);
      return { ...c, ...(entry ? { authorName: entry.name } : {}) };
    });
    return NextResponse.json({ comments: named });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
