/**
 * POST /api/webhooks/frameio
 *
 * Receives Frame.io V4 webhook events. Frame.io signs each request with
 * HMAC-SHA256 over the raw body using the webhook secret — verified here
 * before any processing.
 *
 * Supported events:
 *   comment.created  — top-level comment (parent_id null) or reply (parent_id set)
 *
 * Register this webhook via POST /api/admin/frameio/webhooks.
 * Required env var: FRAMEIO_WEBHOOK_SECRET
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore, getIo } from '@/lib/services/container';
import { readRegistry, getAsset, patchAsset } from '@/lib/store/media-registry';
import { getActivityMonitorService } from '@/lib/services/activity-monitor-service';
import { findAssetVersionByFrameioFileId } from '@/lib/store/canonical-asset-store';
import {
  insertMediaComment,
  updateMediaCommentTextByFrameioId,
  setMediaCommentCompletedByFrameioId,
  softDeleteMediaCommentByFrameioId,
  getMediaCommentByFrameioId,
} from '@/lib/store/media-comment-store';

// ── Signature verification ────────────────────────────────────────────────────

function verifySignature(secret: string, rawBody: string, signatureHeader: string): boolean {
  // Frame.io sends: X-Frameio-Signature: sha256=<hex>
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Asset lookup ──────────────────────────────────────────────────────────────

interface TrackedAsset {
  client_id:    string | null;
  project_id:   string;
  project_name: string;
  asset_id:     string;
  asset_name:   string;
}

function findAssetByFrameioFileId(fileId: string): TrackedAsset | null {
  const projects = getProjectStore().getAll();
  for (const project of projects) {
    const assets = readRegistry(project.projectId);
    const asset  = assets.find((a) => a.frameio.assetId === fileId);
    if (asset) {
      return {
        client_id:    project.clientName?.trim() || null,
        project_id:   project.projectId,
        project_name: project.name,
        asset_id:     asset.assetId,
        asset_name:   asset.name || asset.originalFilename,
      };
    }
  }
  return null;
}

// ── Webhook payload types ─────────────────────────────────────────────────────

interface FrameIoWebhookPayload {
  type: string;
  data: {
    id:           string;
    text?:        string;
    timestamp?:   number | null;
    completed?:   boolean;
    inserted_at?: string;
    file_id?:     string;
    parent_id?:   string | null;
    author?:      { id?: string; name?: string; avatar_url?: string | null };
    owner?:       { id?: string; name?: string; avatar_url?: string | null };
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const secret = process.env.FRAMEIO_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error('[webhooks/frameio] FRAMEIO_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'webhook not configured' }, { status: 500 });
  }

  const rawBody         = await req.text();
  const signatureHeader = req.headers.get('x-frameio-signature') ?? '';

  if (!verifySignature(secret, rawBody, signatureHeader)) {
    console.warn('[webhooks/frameio] signature verification failed');
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let payload: FrameIoWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as FrameIoWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // Acknowledge immediately — processing is synchronous but fast
  handleEvent(payload);

  return NextResponse.json({ ok: true });
}

// Comment events that should trigger a comment-list refresh in the UI.
// All five are registered via POST /api/admin/frameio/webhooks.
const COMMENT_REFRESH_EVENTS = new Set([
  'comment.created',
  'comment.updated',
  'comment.completed',
  'comment.uncompleted',
  'comment.deleted',
]);

function handleEvent(payload: FrameIoWebhookPayload): void {
  const isCommentEvent = COMMENT_REFRESH_EVENTS.has(payload.type);
  if (!isCommentEvent) return;

  const { data } = payload;
  const fileId   = data.file_id;
  if (!fileId) {
    console.warn('[webhooks/frameio] comment.created missing file_id');
    return;
  }

  const tracked = findAssetByFrameioFileId(fileId);
  if (!tracked) {
    console.warn(`[webhooks/frameio] no LPOS asset found for Frame.io file ${fileId} — ignoring`);
    return;
  }

  // Push a real-time refresh signal to any browser viewing this asset so
  // theater mode and the detail panel update without polling.
  getIo()?.emit('frameio:comments:refresh', {
    projectId: tracked.project_id,
    assetId:   tracked.asset_id,
  });

  // Only comment.created affects the count; the others don't add new comments.
  if (payload.type === 'comment.created') {
    const currentAsset = getAsset(tracked.project_id, tracked.asset_id);
    if (currentAsset) {
      patchAsset(tracked.project_id, tracked.asset_id, {
        frameio: { commentCount: (currentAsset.frameio.commentCount ?? 0) + 1 },
      });
    }
  }

  // ── Phase 0 shadow capture (local-comments refactor) ──────────────────────
  // Mirror every comment event into `media_comments` so we can verify capture
  // before Phase 1 swaps the UI's read path. No reader consumes this yet —
  // wrapped in its own try/catch so a shadow-capture failure never breaks
  // the existing activity/refresh-broadcast paths above.
  // See docs/local-comments-refactor-spec.md §12 Phase 0.
  try {
    shadowCaptureComment(payload);
  } catch (err) {
    console.warn(`[webhooks/frameio] shadow-capture failed for ${payload.type} ${data.id}: ${(err as Error).message}`);
  }

  // Only record activity for comment.created events (not edits/completions/deletions).
  if (payload.type !== 'comment.created') return;

  const svc = getActivityMonitorService();
  if (!svc) {
    console.warn('[webhooks/frameio] activity monitor not initialised — event dropped');
    return;
  }

  const author      = data.author ?? data.owner;
  const authorName  = author?.name ?? 'Unknown';
  const occurredAt  = data.inserted_at ?? new Date().toISOString();
  const isReply     = Boolean(data.parent_id);

  if (isReply) {
    svc.recordExternalActivity({
      occurred_at:     occurredAt,
      event_type:      'frameio.comment.reply.created',
      lifecycle_phase: 'commented',
      source_kind:     'external_webhook',
      visibility:      'operator_only',
      actor_type:      'external_user',
      actor_display:   authorName,
      client_id:       tracked.client_id,
      project_id:      tracked.project_id,
      asset_id:        tracked.asset_id,
      source_service:  'frameio',
      source_id:       fileId,
      title:           `New reply on ${tracked.asset_name} in Frame.io`,
      summary:         `${authorName} replied on ${tracked.asset_name}`,
      details_json: {
        frameioFileId:    fileId,
        commentId:        data.parent_id,
        replyId:          data.id,
        authorName,
        createdAt:        occurredAt,
        text:             data.text ?? '',
        assetName:        tracked.asset_name,
        projectName:      tracked.project_name,
      },
      dedupe_key: `frameio-reply:${fileId}:${data.parent_id}:${data.id}`,
    });
  } else {
    svc.recordExternalActivity({
      occurred_at:     occurredAt,
      event_type:      'frameio.comment.created',
      lifecycle_phase: 'commented',
      source_kind:     'external_webhook',
      visibility:      'user_timeline',
      actor_type:      'external_user',
      actor_display:   authorName,
      client_id:       tracked.client_id,
      project_id:      tracked.project_id,
      asset_id:        tracked.asset_id,
      source_service:  'frameio',
      source_id:       fileId,
      title:           `New comment on ${tracked.asset_name} in Frame.io`,
      summary:         `${authorName} commented on ${tracked.asset_name}`,
      details_json: {
        frameioFileId:    fileId,
        commentId:        data.id,
        authorName,
        createdAt:        occurredAt,
        text:             data.text ?? '',
        timestampSeconds: data.timestamp ?? null,
        completed:        data.completed ?? false,
        assetName:        tracked.asset_name,
        projectName:      tracked.project_name,
      },
      dedupe_key: `frameio-comment:${fileId}:${data.id}`,
    });
  }
}

// ── Phase 0 shadow capture ────────────────────────────────────────────────────
//
// Inserts/updates a `media_comments` row from each Frame.io webhook event.
// All §11 design decisions in docs/local-comments-refactor-spec.md are baked in:
//   #1 — version-scoped (asset_version_id NOT NULL, resolved via fileId join)
//   #2 — replies are stored locally; outbound mirror won't push them (Phase 2)
//   #6 — LWW: webhook updates overwrite local row's body/completion
//   #8 — comment.deleted → soft delete (deleted_at set, row preserved)
//
// Idempotency on `frameio_comment_id UNIQUE`: webhook echoes of comments we
// just posted via LPOS get short-circuited inside insertMediaComment.
function shadowCaptureComment(payload: FrameIoWebhookPayload): void {
  const { data } = payload;
  const frameioCommentId = data.id;
  const fileId           = data.file_id;
  if (!frameioCommentId) return;

  switch (payload.type) {
    case 'comment.created': {
      if (!fileId) return;
      const mapping = findAssetVersionByFrameioFileId(fileId);
      if (!mapping) {
        console.warn(`[webhooks/frameio] shadow-capture: no version mapping for file ${fileId} — skipping`);
        return;
      }

      // Resolve the local parent comment_id for replies. Webhook payload's
      // parent_id is a Frame.io comment ID; we look up the local row.
      let parentCommentId: string | null = null;
      if (data.parent_id) {
        const parent = getMediaCommentByFrameioId(data.parent_id);
        parentCommentId = parent?.commentId ?? null;
      }

      const author = data.author ?? data.owner;
      insertMediaComment({
        projectId:          mapping.projectId,
        assetId:            mapping.assetId,
        assetVersionId:     mapping.assetVersionId,
        parentCommentId,
        body:               data.text ?? '',
        timestampSeconds:   typeof data.timestamp === 'number' ? data.timestamp / 24 : null,  // frames → NDF seconds (matches frameio.ts convention)
        durationSeconds:    null,
        authorExternalName: author?.name ?? null,
        authorAvatarUrl:    author?.avatar_url ?? null,
        source:             'frameio',
        frameioCommentId,
        frameioFileId:      fileId,
        completed:          Boolean(data.completed),
        createdAtOverride:  data.inserted_at ?? undefined,
      });
      break;
    }
    case 'comment.updated': {
      if (typeof data.text === 'string') {
        updateMediaCommentTextByFrameioId(frameioCommentId, data.text);
      }
      break;
    }
    case 'comment.completed': {
      setMediaCommentCompletedByFrameioId(frameioCommentId, true, null);
      break;
    }
    case 'comment.uncompleted': {
      setMediaCommentCompletedByFrameioId(frameioCommentId, false, null);
      break;
    }
    case 'comment.deleted': {
      softDeleteMediaCommentByFrameioId(frameioCommentId);
      break;
    }
  }
}
