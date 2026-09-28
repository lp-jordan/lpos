/**
 * GET /share-auth?next=/s/{token} — the LPOS end of the LP Share staff pass
 * ("bounce through LPOS", docs/share-app-spec.md §3).
 *
 * Signed in → mint a one-time 60s staff ticket and send the browser to LP
 * Share, which turns it into its own staff pass and opens `next`.
 * Not signed in → Google sign-in, then back here (return_to round-trip).
 *
 * Public in middleware so an unsigned visitor keeps `next` through sign-in.
 * Only ever redirects to the configured LP Share origin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { buildAppUrl } from '@/lib/services/app-origin';
import { getUserById } from '@/lib/store/user-store';
import { mintStaffTicket, shareAppOrigin } from '@/lib/services/share-app';

function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : '/';
}

export async function GET(req: NextRequest) {
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  const origin = shareAppOrigin();
  if (!origin) return NextResponse.json({ error: 'LP Share is not set up (admin setting share_app.origin).' }, { status: 503 });

  const session = await verifySessionToken(req.cookies.get(APP_SESSION_COOKIE)?.value);
  const user = session && session.role !== 'guest' ? getUserById(session.userId) : null;
  if (!user) {
    const back = `/share-auth?next=${encodeURIComponent(next)}`;
    return NextResponse.redirect(buildAppUrl(`/api/auth/google/connect?return_to=${encodeURIComponent(back)}`, req));
  }

  const ticket = mintStaffTicket({ id: user.id, name: user.name, email: user.email });
  if (!ticket) return NextResponse.json({ error: 'SHARE_STAFF_SECRET is not set.' }, { status: 503 });
  const url = new URL('/api/staff/callback', origin);
  url.searchParams.set('next', next);
  url.searchParams.set('ticket', ticket);
  return NextResponse.redirect(url, { headers: { 'Cache-Control': 'no-store' } });
}
