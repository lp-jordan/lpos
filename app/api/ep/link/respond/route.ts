import { NextRequest, NextResponse } from 'next/server';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById } from '@/lib/store/user-store';
import { mintEpToken } from '@/lib/store/ep-token-store';

const CALLBACK_SCHEME = 'lpos-editpanel://';
const MAX_MACHINE_LEN = 80;

/**
 * POST /api/ep/link/respond
 *
 * Receives the approve/deny submission from /ep/link.
 * On approve: mints a fresh ep_token row and redirects to
 *   <callback>#token=<raw>&user=<email>&machine=<machine>
 *   (hash fragment, never query — keeps the token out of server logs and history)
 * On deny:    redirects to <callback>#error=denied
 */
export async function POST(req: NextRequest) {
  // Auth: must have a logged-in LPOS session.
  const session = await verifySessionToken(req.cookies.get(APP_SESSION_COOKIE)?.value);
  const user = session ? getUserById(session.userId) : null;
  if (!session || !user) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const form = await req.formData();
  const action   = String(form.get('action')   ?? '');
  const machine  = String(form.get('machine')  ?? '').slice(0, MAX_MACHINE_LEN);
  const callback = String(form.get('callback') ?? '');

  // Strict callback validation — only the registered Electron URL scheme is allowed.
  if (!callback.startsWith(CALLBACK_SCHEME)) {
    return NextResponse.json({ error: 'Invalid callback' }, { status: 400 });
  }

  if (action === 'deny') {
    return NextResponse.redirect(`${callback}#error=denied`);
  }

  if (action !== 'approve') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }

  const { rawToken } = mintEpToken(user.id, machine || 'unknown');

  // Hash fragment, not query string — Electron's open-url handler still receives
  // the full URL, but the token never reaches any access log or browser history.
  const target = `${callback}#token=${encodeURIComponent(rawToken)}`
    + `&user=${encodeURIComponent(user.email)}`
    + `&machine=${encodeURIComponent(machine)}`;

  return NextResponse.redirect(target);
}
