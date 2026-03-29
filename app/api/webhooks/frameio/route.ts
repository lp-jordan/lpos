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
import { getProjectStore } from '@/lib/services/container';
import { readRegistry } from '@/lib/store/media-registry';
import { getActivityMonitorService } from '@/lib/services/activity-monitor-service';

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

function handleEvent(payload: FrameIoWebhookPayload): void {
  if (payload.type !== 'comment.created') return;

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
