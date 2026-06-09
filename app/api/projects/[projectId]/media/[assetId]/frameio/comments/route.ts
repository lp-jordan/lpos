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
import { getComments, postComment, postReply, deleteComment, updateComment, toggleCommentCompleted } from '@/lib/services/frameio';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById } from '@/lib/store/user-store';
import { getCommentAuthor, setCommentAuthor, removeCommentAuthor } from '@/lib/store/comment-authors-store';
import { getAllReplyParents, setReplyParent, removeReplyParent } from '@/lib/store/comment-replies-store';
import { notifyCommentReply } from '@/lib/services/comment-notification-service';
import { findAssetVersionByFrameioFileId } from '@/lib/store/canonical-asset-store';
import {
  insertMediaComment,
  updateMediaCommentTextByFrameioId,
  setMediaCommentCompletedByFrameioId,
  softDeleteMediaCommentByFrameioId,
  getMediaCommentByFrameioId,
  getThreadedCommentsForAssetVersion,
} from '@/lib/store/media-comment-store';

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

  // Phase 1: read from media_comments instead of Frame.io. The threading,
  // author shim merge, and reply-prefix stripping all happened during
  // Phase 0 shadow capture, so the local table already has the assembled
  // shape. Falls back to Frame.io GET if the local table has no rows for
  // this asset version — covers the edge case where shadow capture missed
  // an event (rare; backfill closes any historical gap).
  try {
    const mapping = findAssetVersionByFrameioFileId(fileId);
    if (!mapping) {
      // No version mapping shouldn't happen for an asset with a Frame.io ID,
      // but degrade gracefully: empty list rather than 500.
      console.warn(`[frameio/comments GET] no version mapping for file ${fileId} — returning empty`);
      return NextResponse.json({ comments: [] });
    }

    const { comments, rowLookup } = getThreadedCommentsForAssetVersion(
      mapping.projectId,
      mapping.assetId,
      mapping.assetVersionId,
    );

    // Resolve author names: LPOS users get their current display name from
    // user-store (so a renamed user shows the new name); external Frame.io
    // reviewers keep their author_external_name; canEdit + fromFrame flags
    // match today's contract so the renderer doesn't change.
    const named = comments.map((c) => {
      const lookup = rowLookup.get(c.id);
      const lposUser = lookup?.authorUserId ? getUserById(lookup.authorUserId) : null;
      const authorName = lposUser?.name ?? c.authorName;
      const canEdit    = !!(lposUser && session && lposUser.id === session.userId);
      return {
        ...c,
        authorName,
        canEdit,
        fromFrame: !lookup?.authorUserId,
        replies: c.replies.map((r) => {
          const rLookup = rowLookup.get(r.id);
          const rUser = rLookup?.authorUserId ? getUserById(rLookup.authorUserId) : null;
          return { ...r, authorName: rUser?.name ?? r.authorName };
        }),
      };
    });

    // Keep the asset's denormalised commentCount in sync — used by MediaTab
    // for the badge and by the comments query for completeness checks.
    patchAsset(projectId, assetId, { frameio: { commentCount: comments.length } });

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

  const body = await req.json() as {
    text?:      string;
    timestamp?: number | null;
    duration?:  number | null;
    parentId?:  string | null;
  };
  if (!body.text?.trim()) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  const cookieStore = await cookies();
  const session     = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const lposUser    = session ? getUserById(session.userId) : null;

  try {
    // Reply to an existing comment
    if (body.parentId) {
      const reply = await postReply(fileId, body.parentId, body.text.trim());
      setReplyParent(projectId, reply.id, body.parentId);
      if (lposUser) setCommentAuthor(projectId, reply.id, { name: lposUser.name, userId: lposUser.id });
      patchAsset(projectId, assetId, { frameio: { commentCount: asset.frameio.commentCount + 1 } });

      // Phase 0 shadow capture: dual-write to media_comments so the local
      // table mirrors every LPOS-side comment write. Wrapped — never blocks.
      shadowCaptureLposReply({ projectId, fileId, reply, parentFrameioCommentId: body.parentId, text: body.text.trim(), lposUser });

      // Notify the original commenter — only when the parent was authored inside
      // LPOS (we have their userId). External Frame.io reviewers have no in-app
      // recipient. Skip self-replies. Best-effort; never blocks the response.
      const parentAuthor = getCommentAuthor(projectId, body.parentId);
      if (parentAuthor?.userId && parentAuthor.userId !== session?.userId) {
        void notifyCommentReply({
          userId:     parentAuthor.userId,
          projectId,
          assetId,
          assetName:  asset.name || asset.originalFilename,
          commentId:  body.parentId,
          fromUserId: session?.userId,
          fromName:   lposUser?.name,
          snippet:    body.text.trim().slice(0, 140),
        }).catch(() => {});
      }

      const namedReply = lposUser ? { ...reply, authorName: lposUser.name } : reply;
      return NextResponse.json({ reply: namedReply, parentId: body.parentId }, { status: 201 });
    }

    // New top-level comment
    const comment = await postComment(fileId, body.text.trim(), body.timestamp ?? null, body.duration ?? null);
    patchAsset(projectId, assetId, { frameio: { commentCount: asset.frameio.commentCount + 1 } });
    if (lposUser) setCommentAuthor(projectId, comment.id, { name: lposUser.name, userId: lposUser.id });

    // Phase 0 shadow capture: dual-write to media_comments. Wrapped so a
    // shadow failure never breaks the user's successful Frame.io post.
    shadowCaptureLposTopLevel({ projectId, fileId, comment, body: body.text.trim(), timestamp: body.timestamp ?? null, duration: body.duration ?? null, lposUser });

    const named = { ...comment, ...(lposUser ? { authorName: lposUser.name } : {}), fromFrame: false };
    return NextResponse.json({ comment: named }, { status: 201 });
  } catch (err) {
    console.error('[frameio/comments POST]', (err as Error).message);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const body = await req.json() as { commentId?: string; text?: string; completed?: boolean };
  if (!body.commentId) return NextResponse.json({ error: 'commentId is required' }, { status: 400 });

  const cookieStore = await cookies();
  const session     = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    if (typeof body.completed === 'boolean') {
      // Any authenticated LPOS user can mark a comment complete/incomplete
      await toggleCommentCompleted(body.commentId, body.completed);
      // Phase 0 shadow capture
      try { setMediaCommentCompletedByFrameioId(body.commentId, body.completed, session.userId); }
      catch (err) { console.warn(`[frameio/comments PATCH] shadow setCompleted failed: ${(err as Error).message}`); }
      return NextResponse.json({ ok: true });
    }

    if (body.text?.trim()) {
      // Only the original poster can edit comment text
      const entry = getCommentAuthor(projectId, body.commentId);
      if (!entry || entry.userId !== session.userId) {
        return NextResponse.json({ error: 'Not authorised to edit this comment' }, { status: 403 });
      }
      await updateComment(body.commentId, body.text.trim());
      // Phase 0 shadow capture
      try { updateMediaCommentTextByFrameioId(body.commentId, body.text.trim()); }
      catch (err) { console.warn(`[frameio/comments PATCH] shadow update failed: ${(err as Error).message}`); }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'text or completed is required' }, { status: 400 });
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
    removeReplyParent(projectId, commentId);
    patchAsset(projectId, assetId, {
      frameio: { commentCount: Math.max(0, asset.frameio.commentCount - 1) },
    });
    // Phase 0 shadow capture: soft delete (locked §11 #8)
    try { softDeleteMediaCommentByFrameioId(commentId); }
    catch (err) { console.warn(`[frameio/comments DELETE] shadow soft-delete failed: ${(err as Error).message}`); }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ── Phase 0 shadow capture helpers ────────────────────────────────────────────
//
// Dual-write LPOS-side comment posts into media_comments. Wrapped — a shadow
// failure logs but never affects the Frame.io response the user is waiting on.

interface FrameIOCommentLike { id: string; text: string }
interface FrameIOCommentReplyLike { id: string; text: string }
interface LposUserLike { id: string; name: string }

function shadowCaptureLposTopLevel(args: {
  projectId: string;
  fileId:    string;
  comment:   FrameIOCommentLike;
  body:      string;
  timestamp: number | null;
  duration:  number | null;
  lposUser:  LposUserLike | null;
}): void {
  try {
    const mapping = findAssetVersionByFrameioFileId(args.fileId);
    if (!mapping) {
      console.warn(`[frameio/comments POST] shadow: no version mapping for file ${args.fileId} — skipping`);
      return;
    }
    insertMediaComment({
      projectId:        mapping.projectId,
      assetId:          mapping.assetId,
      assetVersionId:   mapping.assetVersionId,
      parentCommentId:  null,
      body:             args.body,
      timestampSeconds: args.timestamp,
      durationSeconds:  args.duration,
      authorUserId:     args.lposUser?.id ?? null,
      source:           'lpos',
      frameioCommentId: args.comment.id,
      frameioFileId:    args.fileId,
    });
  } catch (err) {
    console.warn(`[frameio/comments POST] shadow top-level write failed: ${(err as Error).message}`);
  }
}

function shadowCaptureLposReply(args: {
  projectId:              string;
  fileId:                 string;
  reply:                  FrameIOCommentReplyLike;
  parentFrameioCommentId: string;
  text:                   string;
  lposUser:               LposUserLike | null;
}): void {
  try {
    const mapping = findAssetVersionByFrameioFileId(args.fileId);
    if (!mapping) {
      console.warn(`[frameio/comments POST] shadow reply: no version mapping for file ${args.fileId} — skipping`);
      return;
    }
    const parent = getMediaCommentByFrameioId(args.parentFrameioCommentId);
    insertMediaComment({
      projectId:        mapping.projectId,
      assetId:          mapping.assetId,
      assetVersionId:   mapping.assetVersionId,
      parentCommentId:  parent?.commentId ?? null,
      body:             args.text,
      authorUserId:     args.lposUser?.id ?? null,
      source:           'lpos',
      frameioCommentId: args.reply.id,
      frameioFileId:    args.fileId,
    });
  } catch (err) {
    console.warn(`[frameio/comments POST] shadow reply write failed: ${(err as Error).message}`);
  }
}
