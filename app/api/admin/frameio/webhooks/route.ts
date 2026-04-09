/**
 * GET    /api/admin/frameio/webhooks  — list registered webhooks
 * POST   /api/admin/frameio/webhooks  — register a new webhook
 * DELETE /api/admin/frameio/webhooks  — delete a webhook by ID
 *
 * POST body: { url?: string, name?: string }
 *   url defaults to APP_BASE_URL + /api/webhooks/frameio
 *   name defaults to "LPOS Comments"
 *
 * DELETE body: { id: string }
 *
 * The webhook secret returned on creation must be saved to FRAMEIO_WEBHOOK_SECRET
 * in .env.local — it is never retrievable again from the Frame.io API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { registerWebhook, listWebhooks, deleteWebhook } from '@/lib/services/frameio';
import { requireRole } from '@/lib/services/api-auth';

const COMMENT_EVENTS = [
  'comment.created',
  'comment.updated',
  'comment.completed',
  'comment.uncompleted',
  'comment.deleted',
];

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  try {
    const webhooks = await listWebhooks();
    return NextResponse.json({ webhooks });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  try {
    const body = await req.json() as { url?: string; name?: string };

    const baseUrl = process.env.APP_BASE_URL?.trim();
    if (!baseUrl && !body.url) {
      return NextResponse.json(
        { error: 'Provide a url in the request body or set APP_BASE_URL in .env.local' },
        { status: 400 },
      );
    }

    const url  = body.url ?? `${baseUrl}/api/webhooks/frameio`;
    const name = body.name ?? 'LPOS Comments';

    const webhook = await registerWebhook(name, url, COMMENT_EVENTS);

    return NextResponse.json({
      webhook,
      next_step: 'Save the secret to FRAMEIO_WEBHOOK_SECRET in .env.local — it will not be shown again.',
    }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  try {
    const body = await req.json() as { id?: string };
    if (!body.id?.trim()) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    await deleteWebhook(body.id.trim());
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
