import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getAsset } from '@/lib/store/media-registry';
import { toggleCommentCompleted } from '@/lib/services/frameio';

type Ctx = { params: Promise<{ projectId: string; assetId: string; commentId: string }> };

/**
 * PATCH /api/ep/projects/:projectId/assets/:assetId/comments/:commentId
 *
 * Phase 5c.10 (2026-06-03): mark a Frame.io comment complete (or reopen it)
 * from editpanel. Wraps the Frame.io toggleCommentCompleted call so the
 * editor's "Mark complete" action in the CommentPullReport flows all the way
 * back to Frame.io — comment becomes `completed: true` upstream, and the
 * editor's next Pull Comments treats it as resolved (marker removed).
 *
 * Body: { completed: boolean }
 *
 * The asset scoping in the URL is for access control consistency with the
 * other `/api/ep/projects/:id/assets/:assetId/...` routes — the underlying
 * Frame.io call only needs commentId, so we don't strictly need to verify
 * the comment belongs to this asset, but resolving the asset confirms the
 * editor has visibility on its project.
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

  try {
    await toggleCommentCompleted(commentId, body.completed);
    return NextResponse.json({ ok: true, commentId, completed: body.completed });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
