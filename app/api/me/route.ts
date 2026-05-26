import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById, setNasIngestActive, toUserSummary } from '@/lib/store/user-store';

export async function GET() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ user: null });

  const user = toUserSummary(getUserById(session.userId));
  return NextResponse.json({ user });
}

export async function PATCH(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { nasIngestActive?: boolean };
  if (typeof body.nasIngestActive === 'boolean') {
    setNasIngestActive(session.userId, body.nasIngestActive);
  }

  const user = toUserSummary(getUserById(session.userId));
  return NextResponse.json({ user });
}
