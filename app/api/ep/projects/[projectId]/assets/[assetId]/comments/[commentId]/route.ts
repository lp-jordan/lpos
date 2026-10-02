import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getAsset } from '@/lib/store/media-registry';
import {
  getMediaCommentByEitherId,
  setMediaCommentCompletedById,
} from '@/lib/store/media-comment-store';

type Ctx = { params: Promise<{ projectId: string; assetId: string; commentId: string }> };

/**
 * PATCH /api/ep/projects/:projectId/assets/:assetId/comments/:commentId
 *
 * Mark a comment done (or reopen it) from EditPanel's comment pull report.
 * Writes the LPOS comments system only — LPOS is the source of truth. LP Share
 * picks the change up on its next sync tick (lib/services/share-app.ts
 * pushComments), and EditPanel's next pull drops the marker.
 *
 * Body: { completed: boolean }
 *
 * `commentId` is the local comment_id. A legacy Frame.io comment id is still
 * accepted so reports saved by older EditPanel builds keep working.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const { projectId, assetId, commentId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  let body: { completed?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.completed !== 'boolean') {
    return NextResponse.json({ error: 'completed must be a boolean' }, { status: 400 });
  }
  if (!commentId.trim()) {
    return NextResponse.json({ error: 'commentId is required' }, { status: 400 });
  }

  const target = getMediaCommentByEitherId(commentId);
  if (!target) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });

  try {
    // EditPanel actions have no LPOS user session, so completed_by_user_id is
    // null; the EP-token auth on this route is the audit trail.
    setMediaCommentCompletedById(target.commentId, body.completed, null);
    return NextResponse.json({ ok: true, commentId, completed: body.completed });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
