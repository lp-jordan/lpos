/**
 * GET /api/auth/join/presentation
 *
 * Direct-access link for studio guest devices. Creates (or refreshes) a guest
 * session and lands the user on the Slate page with the Presentation tab open.
 *
 * If the request already carries a valid non-guest session it is left alone and
 * the user is simply redirected — no session downgrade.
 *
 * SECURITY NOTE: This route issues a guest session with no PIN or credential
 * check — possession of the URL is sufficient for access. It is intentionally
 * designed for use on a closed internal network (LAN or Tailscale) only.
 * Do NOT expose this route on a publicly reachable server.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  APP_SESSION_COOKIE,
  createSessionToken,
  getSessionCookieOptions,
  verifySessionToken,
} from '@/lib/services/session-auth';
import { getOrCreateGuestUser } from '@/lib/store/user-store';

export async function GET() {
  const cookieStore = await cookies();
  const existing = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);

  if (!existing || existing.role === 'guest') {
    const guest = getOrCreateGuestUser();
    const token = await createSessionToken(guest.id, 'guest');
    cookieStore.set(APP_SESSION_COOKIE, token, getSessionCookieOptions());
  }

  redirect('/slate#presentation');
}
