import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getProspectNotificationStore } from '@/lib/services/container';

export async function GET() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const store = getProspectNotificationStore();
  return NextResponse.json({
    notifications: store.getForUser(session.userId),
    unreadCount:   store.getUnreadCount(session.userId),
  });
}

export async function PATCH(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { markAllRead?: boolean };
  if (body.markAllRead) {
    getProspectNotificationStore().markAllRead(session.userId);
  }
  return NextResponse.json({ ok: true });
}
