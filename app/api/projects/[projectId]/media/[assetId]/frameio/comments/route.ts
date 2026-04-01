/**
 * GET  /api/projects/[projectId]/media/[assetId]/frameio/comments
 *   → Fetch all comments for this asset from Frame.io
 *
 * POST /api/projects/[projectId]/media/[assetId]/frameio/comments
 *   → Post a new comment { text, timestamp? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getComments, postComment, deleteComment, updateComment } from '@/lib/services/frameio';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById } from '@/lib/store/user-store';
import { getCommentAuthor, setCommentAuthor, removeCommentAuthor } from '@/lib/store/comment-authors-store';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const fileId = asset.frameio.assetId;
  if (!fileId) {
    return NextResponse.json({ comments: [] });
  }

  const cookieStore = await cookies();
  const session     = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);

  try {
    const comments = await getComments(fileId);
    patchAsset(projectId, assetId, { frameio: { commentCount: comments.length } });
    const named = comments.map(c => {
      const entry = getCommentAuthor(projectId, c.id);
      return {
        ...c,
        ...(entry ? { authorName: entry.name } : {}),
        canEdit:   !!(entry && session && entry.userId === session.userId),
        fromFrame: !entry,
      };
    });
    return NextResponse.json({ comments: named });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const fileId = asset.frameio.assetId;
  if (!fileId) {
    return NextResponse.json({ error: 'Asset has not been uploaded to Frame.io yet' }, { status: 400 });
  }

  const body = await req.json() as { text?: string; timestamp?: number | null; duration?: number | null };
  if (!body.text?.trim()) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  const cookieStore = await cookies();
  const session     = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const lposUser    = session ? getUserById(session.userId) : null;

  try {
    const comment = await postComment(fileId, body.text.trim(), body.timestamp ?? null, body.duration ?? null);
    patchAsset(projectId, assetId, {
      frameio: { commentCount: asset.frameio.commentCount + 1 },
    });
    if (lposUser) setCommentAuthor(projectId, comment.id, { name: lposUser.name, userId: lposUser.id });
    const named = { ...comment, ...(lposUser ? { authorName: lposUser.name } : {}), fromFrame: false };
    return NextResponse.json({ comment: named }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const { commentId, text } = await req.json() as { commentId?: string; text?: string };
  if (!commentId) return NextResponse.json({ error: 'commentId is required' }, { status: 400 });
  if (!text?.trim()) return NextResponse.json({ error: 'text is required' }, { status: 400 });

  const cookieStore = await cookies();
  const session     = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const entry       = getCommentAuthor(projectId, commentId);
  if (!session || !entry || entry.userId !== session.userId) {
    return NextResponse.json({ error: 'Not authorised to edit this comment' }, { status: 403 });
  }

  try {
    await updateComment(commentId, text.trim());
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const { commentId } = await req.json() as { commentId?: string };
  if (!commentId) return NextResponse.json({ error: 'commentId is required' }, { status: 400 });

  try {
    await deleteComment(commentId);
    removeCommentAuthor(projectId, commentId);
    patchAsset(projectId, assetId, {
      frameio: { commentCount: Math.max(0, asset.frameio.commentCount - 1) },
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
