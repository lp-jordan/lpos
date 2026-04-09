import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getCoreDb } from '@/lib/store/core-db';

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 });
  }

  getCoreDb()
    .prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    )
    .run(session.userId, body.endpoint, body.keys.p256dh, body.keys.auth, new Date().toISOString());

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { endpoint?: string };
  if (body.endpoint) {
    getCoreDb()
      .prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .run(session.userId, body.endpoint);
  }

  return NextResponse.json({ ok: true });
}
