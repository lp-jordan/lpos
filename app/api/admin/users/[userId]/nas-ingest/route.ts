import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById, setNasIngestAccess, toUserSummary } from '@/lib/store/user-store';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { userId } = await params;
  const body = await req.json() as { enabled: boolean };
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled (boolean) is required' }, { status: 400 });
  }

  const target = getUserById(userId);
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  setNasIngestAccess(userId, body.enabled);
  return NextResponse.json({ user: toUserSummary(getUserById(userId)) });
}
