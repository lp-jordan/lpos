import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getAsset } from '@/lib/store/media-registry';
import {
  getMediaCommentByEitherId,
  setMediaCommentCompletedById,
  enqueueMediaCommentMirrorJob,
} from '@/lib/store/media-comment-store';

type Ctx = { params: Promise<{ projectId: string; assetId: string; commentId: string }> };

/**
 * PATCH /api/ep/projects/:projectId/assets/:assetId/comments/:commentId
 *
 * Mark a comment complete (or reopen it) from editpanel. Wraps the local
 * write + outbound mirror enqueue so the editor's "Mark complete" action
 * in CommentPullReport flips state locally instantly and reflects to
 * Frame.io eventually-consistently. The editor's next Pull Comments
 * treats completed=true as resolved (marker removed).
 *
 * Body: { completed: boolean }
 *
 * Phase 2 of the local-comments refactor (docs/local-comments-refactor-spec.md):
 *   - Was: synchronous toggleCommentCompleted to Frame.io
 *   - Now: setMediaCommentCompletedById + enqueueMediaCommentMirrorJob,
 *          returns 200 immediately. Mirror worker pushes the change to
 *          Frame.io within seconds. If the mirror abandons (Frame.io down
 *          for 3+ hours), the editor never sees the completion in Frame.io
 *          — locally it's flipped, and the editpanel's next Pull will pick
 *          up the local state via the GET route.
 *
 * The `commentId` URL parameter is either the Frame.io comment id (used by
 * editpanel today) or the local comment_id. The store resolves either.
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
    // Editpanel actions don't have an LPOS user session — pass null for
    // completed_by_user_id. The mirror worker still pushes the completion
    // to Frame.io; the audit trail says "EP action" by virtue of the
    // EP-token auth on this route.
    setMediaCommentCompletedById(target.commentId, body.completed, null);
    enqueueMediaCommentMirrorJob(target.commentId, body.completed ? 'complete' : 'uncomplete');
    return NextResponse.json({ ok: true, commentId, completed: body.completed });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
