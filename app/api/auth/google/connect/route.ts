import { NextRequest, NextResponse } from 'next/server';
import {
  GOOGLE_STATE_COOKIE,
  POST_SIGNIN_REDIRECT_COOKIE,
  createGoogleState,
  getSessionCookieOptions,
} from '@/lib/services/session-auth';
import { buildAppUrl } from '@/lib/services/app-origin';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

function getRedirectUri(req: NextRequest): string {
  return process.env.GOOGLE_REDIRECT_URI?.trim() || buildAppUrl('/api/auth/google/callback', req).toString();
}

/**
 * Only allow same-origin redirect paths (e.g. `/ep/link?...`) — never absolute
 * URLs, never custom schemes. Prevents open-redirect abuse on the post-signin
 * round-trip.
 */
function sanitizeReturnTo(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) {
    return NextResponse.redirect(buildAppUrl('/signin?error=config', req));
  }

  const state = createGoogleState();
  const redirectUri = getRedirectUri(req);
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('state', state);

  const response = NextResponse.redirect(url);
  response.cookies.set(GOOGLE_STATE_COOKIE, state, {
    ...getSessionCookieOptions(10 * 60),
  });

  // Round-trip a post-signin redirect (e.g. /ep/link?machine=...) through Google.
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get('return_to'));
  if (returnTo) {
    response.cookies.set(POST_SIGNIN_REDIRECT_COOKIE, returnTo, {
      ...getSessionCookieOptions(10 * 60),
    });
  }
  return response;
}
