import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { hasHiringAccess } from '@/lib/store/hiring-access-store';

/**
 * Returns a 401/403 NextResponse if the request lacks Hiring access, else null.
 *
 * Deliberately NOT in api-auth.ts alongside `requireProspectsAccess`: every
 * other helper there treats admin as sufficient, and putting this one next to
 * them invites someone to "fix the inconsistency". Admin is not sufficient
 * here — candidate assessments are granted explicitly.
 */
export async function requireHiringAccess(req: NextRequest): Promise<NextResponse | null> {
  const session = await verifySessionToken(req.cookies.get(APP_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  }
  if (!hasHiringAccess(session.userId, session.role === 'admin')) {
    return NextResponse.json({ error: 'You do not have access to Hiring.' }, { status: 403 });
  }
  return null;
}
