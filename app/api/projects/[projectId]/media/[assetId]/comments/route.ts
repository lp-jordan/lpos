/**
 * GET  /api/projects/[projectId]/media/[assetId]/comments
 *   → Fetch all comments for this asset (LPOS-owned; Frame.io optional)
 *
 * POST /api/projects/[projectId]/media/[assetId]/comments
 *   → Post a new comment { text, timestamp?, duration?, parentId? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getAsset } from '@/lib/store/media-registry';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById } from '@/lib/store/user-store';
import { notifyCommentReply } from '@/lib/services/comment-notification-service';
import { findAssetVersionByFrameioFileId, getCurrentAssetVersion } from '@/lib/store/canonical-asset-store';
import {
  insertMediaComment,
  getMediaCommentByEitherId,
  updateMediaCommentTextById,
  setMediaCommentCompletedById,
  softDeleteMediaCommentById,
  enqueueMediaCommentMirrorJob,
  getThreadedCommentsForAssetVersion,
} from '@/lib/store/media-comment-store';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * Resolve the (project, asset, version) scope a comment read/write targets.
 *
 * LPOS owns comments, so this works whether or not the asset is on Frame.io:
 * when a Frame.io file id exists we honour its version mapping (keeps inbound
 * webhook captures and outbound mirrors on the same version row), otherwise we
 * fall back to the asset's current LPOS version. Returns null only when the
 * asset has no versions at all (shouldn't happen for a registered asset).
 */
function resolveCommentScope(
  projectId: string,
  assetId:   string,
  fileId:    string | null,
): { projectId: string; assetId: string; assetVersionId: string } | null {
  if (fileId) {
    const mapping = findAssetVersionByFrameioFileId(fileId);
    if (mapping) return mapping;
  }
  const version = getCurrentAssetVersion(assetId);
  if (version) return { projectId, assetId, assetVersionId: version.asset_version_id };
  return null;
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  // Frame.io optional: fileId may be null. The scope resolver falls back to
  // the asset's current LPOS version when there's no Frame.io mapping.
  const fileId = asset.frameio.assetId;

  const cookieStore = await cookies();
  const session     = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);

  // Phase 1: read from media_comments instead of Frame.io.
  // Phase 3: accept ?version=<assetVersionId> to scope comments to one
  // version (used by the sidebar version cycler in MediaDetailPanel). When
  // absent, defaults to the asset's current version (via Frame.io mapping if
  // present, else the LPOS-native current version).
  const requestedVersionId = new URL(req.url).searchParams.get('version');
  try {
    let resolvedProjectId:     string;
    let resolvedAssetId:       string;
    let resolvedAssetVersionId: string;

    if (requestedVersionId) {
      // Explicit version — trust it but scope by project + asset to keep
      // callers from cross-querying.
      resolvedProjectId      = projectId;
      resolvedAssetId        = assetId;
      resolvedAssetVersionId = requestedVersionId;
    } else {
      const scope = resolveCommentScope(projectId, assetId, fileId);
      if (!scope) {
        // Asset has no versions at all — degrade gracefully to an empty list.
        console.warn(`[comments GET] no version for asset ${assetId} — returning empty`);
        return NextResponse.json({ comments: [] });
      }
      resolvedProjectId      = scope.projectId;
      resolvedAssetId        = scope.assetId;
      resolvedAssetVersionId = scope.assetVersionId;
    }

    const { comments, rowLookup } = getThreadedCommentsForAssetVersion(
      resolvedProjectId,
      resolvedAssetId,
      resolvedAssetVersionId,
    );

    // Resolve author names + avatars: LPOS users get their current display
    // name and avatar from user-store (so a renamed/re-pictured user shows
    // the new value); external Frame.io reviewers keep their snapshot
    // (author_external_name + Frame.io avatar URL on the comment). canEdit +
    // fromFrame flags match today's contract so the renderer doesn't change.
    const named = comments.map((c) => {
      const lookup = rowLookup.get(c.id);
      const lposUser = lookup?.authorUserId ? getUserById(lookup.authorUserId) : null;
      const authorName   = lposUser?.name ?? c.authorName;
      const authorAvatar = lposUser?.avatarUrl ?? c.authorAvatar;
      const canEdit      = !!(lposUser && session && lposUser.id === session.userId);
      return {
        ...c,
        authorName,
        authorAvatar,
        canEdit,
        fromFrame: !lookup?.authorUserId,
        replies: c.replies.map((r) => {
          const rLookup = rowLookup.get(r.id);
          const rUser = rLookup?.authorUserId ? getUserById(rLookup.authorUserId) : null;
          return {
            ...r,
            authorName:   rUser?.name ?? r.authorName,
            authorAvatar: rUser?.avatarUrl ?? r.authorAvatar,
          };
        }),
      };
    });

    // Comment counts are computed on read by the media-list route now
    // (getCommentCountByAssetForProject) — no denormalised count to sync here.

    return NextResponse.json({ comments: named });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  // Frame.io optional: an asset that was never pushed to Frame.io can still be
  // commented on. fileId may be null; the scope resolver and mirror enqueue
  // below both handle that.
  const fileId = asset.frameio.assetId;

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

  // Resolve which asset_version this comment pins to (locked decision §11 #1 —
  // version-scoped). Mirrors the GET handler: Frame.io mapping when the asset
  // is on Frame.io, else the asset's current LPOS version.
  const mapping = resolveCommentScope(projectId, assetId, fileId);
  if (!mapping) {
    return NextResponse.json({ error: 'Asset has no version to attach the comment to' }, { status: 500 });
  }

  try {
    // ── Phase 2 reversal: write local FIRST, enqueue mirror, return now ────
    //
    // The user's comment lands in media_comments before this handler returns.
    // The MediaCommentMirrorService picks up the enqueued job within a few
    // seconds and POSTs to Frame.io in the background. If that mirror fails
    // for 3 hours, the comment gets the `!` indicator on its next render
    // (locked §11 #7).

    // ── Reply path: stays LPOS-only (locked §11 #2). Never enqueued. ───────
    if (body.parentId) {
      const parent = getMediaCommentByEitherId(body.parentId);
      if (!parent) {
        return NextResponse.json({ error: 'Parent comment not found' }, { status: 404 });
      }

      const reply = insertMediaComment({
        projectId:        mapping.projectId,
        assetId:          mapping.assetId,
        assetVersionId:   mapping.assetVersionId,
        parentCommentId:  parent.commentId,
        body:             body.text.trim(),
        authorUserId:     lposUser?.id ?? null,
        source:           'lpos',
        frameioFileId:    fileId,
      });

      // Notify the original commenter — only when the parent was authored
      // inside LPOS (we have their user id in author_user_id). Skip self-
      // replies. Best-effort.
      if (parent.authorUserId && parent.authorUserId !== session?.userId) {
        const parentUser = getUserById(parent.authorUserId);
        if (parentUser) {
          void notifyCommentReply({
            userId:     parent.authorUserId,
            projectId,
            assetId,
            assetName:  asset.name || asset.originalFilename,
            commentId:  parent.commentId,
            fromUserId: session?.userId,
            fromName:   lposUser?.name,
            snippet:    body.text.trim().slice(0, 140),
          }).catch(() => {});
        }
      }

      const replyResponse = {
        id:               reply.commentId,
        frameioCommentId: reply.frameioCommentId ?? null,
        text:             reply.body,
        authorName:       lposUser?.name ?? reply.authorExternalName ?? '',
        // Prefer the live user-store avatar so the row shows a real picture
        // even though insert never snapshots author_avatar_url for LPOS users.
        authorAvatar:     lposUser?.avatarUrl ?? reply.authorAvatarUrl,
        createdAt:    reply.createdAt,
      };
      return NextResponse.json({
        reply:    replyResponse,
        // Stable local id — matches the parent's outward `id` (now always
        // comment_id), so the client's optimistic insert can't miss. This
        // permanently retires the reply-vanish race from the id-flip.
        parentId: parent.commentId,
      }, { status: 201 });
    }

    // ── Top-level path: enqueue 'create' mirror so clients see it in Frame.io.
    const comment = insertMediaComment({
      projectId:        mapping.projectId,
      assetId:          mapping.assetId,
      assetVersionId:   mapping.assetVersionId,
      parentCommentId:  null,
      body:             body.text.trim(),
      timestampSeconds: body.timestamp ?? null,
      durationSeconds:  body.duration ?? null,
      authorUserId:     lposUser?.id ?? null,
      source:           'lpos',
      frameioFileId:    fileId,
    });

    // Only mirror outbound when the asset is actually on Frame.io — LPOS-only
    // assets keep comments local (nothing to mirror to). The mirror worker
    // also can't post without a Frame.io file id.
    if (fileId) enqueueMediaCommentMirrorJob(comment.commentId, 'create');

    const named = {
      id:              comment.commentId,
      frameioCommentId: null,
      text:            comment.body,
      timestamp:       comment.timestampSeconds,
      duration:        comment.durationSeconds,
      authorName:      lposUser?.name ?? comment.authorExternalName ?? '',
      // See reply branch above — live user-store avatar wins over the row's
      // (NULL for LPOS-authored comments since insert doesn't snapshot it).
      authorAvatar:    lposUser?.avatarUrl ?? comment.authorAvatarUrl,
      createdAt:       comment.createdAt,
      completed:       comment.completed,
      replies:         [] as Array<unknown>,
      fromFrame:       false,
      mirrorAbandoned: false,
    };
    return NextResponse.json({ comment: named }, { status: 201 });
  } catch (err) {
    console.error('[comments POST]', (err as Error).message);
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

  // Phase 2 reversal: look up + mutate the LOCAL row; enqueue mirror.
  // `body.commentId` may be either the local comment_id (fresh comments
  // whose mirror hasn't landed yet) or the Frame.io comment id (backfilled
  // + everything pre-Phase-2).
  const target = getMediaCommentByEitherId(body.commentId);
  if (!target) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });

  try {
    if (typeof body.completed === 'boolean') {
      // Any authenticated LPOS user can mark a comment complete/incomplete.
      setMediaCommentCompletedById(target.commentId, body.completed, session.userId);
      enqueueMediaCommentMirrorJob(target.commentId, body.completed ? 'complete' : 'uncomplete');
      return NextResponse.json({ ok: true });
    }

    if (body.text?.trim()) {
      // Only the original poster can edit comment text.
      if (!target.authorUserId || target.authorUserId !== session.userId) {
        return NextResponse.json({ error: 'Not authorised to edit this comment' }, { status: 403 });
      }
      updateMediaCommentTextById(target.commentId, body.text.trim());
      // Replies never mirror outbound (locked §11 #2); only enqueue updates
      // for top-level comments.
      if (!target.parentCommentId) {
        enqueueMediaCommentMirrorJob(target.commentId, 'update');
      }
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

  const target = getMediaCommentByEitherId(commentId);
  if (!target) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });

  try {
    // Phase 2: soft-delete local (locked §11 #8), enqueue mirror delete.
    softDeleteMediaCommentById(target.commentId);
    // Replies never mirror outbound (locked §11 #2). And if the comment never
    // got a frameio_comment_id (mirror never landed), there's nothing on
    // Frame.io to delete — the worker handles that case gracefully.
    if (!target.parentCommentId) {
      enqueueMediaCommentMirrorJob(target.commentId, 'delete');
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
