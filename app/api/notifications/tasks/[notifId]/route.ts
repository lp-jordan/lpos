import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskNotificationStore } from '@/lib/services/container';

type Params = { params: Promise<{ notifId: string }> };

export async function PATCH(_req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { notifId } = await params;
  getTaskNotificationStore().markRead(notifId);
  return NextResponse.json({ ok: true });
}
