import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskNotificationStore } from '@/lib/services/container';

export async function GET() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const store = getTaskNotificationStore();
  const notifications = store.getForUser(session.userId);
  const unreadCount = store.getUnreadCount(session.userId);
  return NextResponse.json({ notifications, unreadCount });
}

export async function PATCH(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { markAllRead?: boolean };
  if (body.markAllRead) {
    getTaskNotificationStore().markAllRead(session.userId);
  }
  return NextResponse.json({ ok: true });
}
