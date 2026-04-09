import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookieOptions, APP_SESSION_COOKIE, GOOGLE_STATE_COOKIE, createSessionToken } from '@/lib/services/session-auth';
import { buildAppUrl } from '@/lib/services/app-origin';
import { upsertGoogleUser } from '@/lib/store/user-store';
import { isAdminEmail } from '@/lib/store/admin-store';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function getRedirectUri(req: NextRequest): string {
  return process.env.GOOGLE_REDIRECT_URI?.trim() || buildAppUrl('/api/auth/google/callback', req).toString();
}

function redirectWithError(req: NextRequest, code: string) {
  return NextResponse.redirect(buildAppUrl(`/signin?error=${code}`, req));
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const stateCookie = req.cookies.get(GOOGLE_STATE_COOKIE)?.value;

  if (!code || !state || !stateCookie || state !== stateCookie) {
    const response = redirectWithError(req, 'state');
    response.cookies.set(GOOGLE_STATE_COOKIE, '', clearSessionCookieOptions());
    return response;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    const response = redirectWithError(req, 'config');
    response.cookies.set(GOOGLE_STATE_COOKIE, '', clearSessionCookieOptions());
    return response;
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(req),
    }),
    cache: 'no-store',
  });

  if (!tokenRes.ok) {
    const response = redirectWithError(req, 'token');
    response.cookies.set(GOOGLE_STATE_COOKIE, '', clearSessionCookieOptions());
    return response;
  }

  const tokenJson = await tokenRes.json() as { access_token?: string };
  if (!tokenJson.access_token) {
    const response = redirectWithError(req, 'token');
    response.cookies.set(GOOGLE_STATE_COOKIE, '', clearSessionCookieOptions());
    return response;
  }

  const profileRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    cache: 'no-store',
  });

  if (!profileRes.ok) {
    const response = redirectWithError(req, 'profile');
    response.cookies.set(GOOGLE_STATE_COOKIE, '', clearSessionCookieOptions());
    return response;
  }

  const profile = await profileRes.json() as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };

  if (!profile.sub || !profile.email || !profile.name) {
    const response = redirectWithError(req, 'profile');
    response.cookies.set(GOOGLE_STATE_COOKIE, '', clearSessionCookieOptions());
    return response;
  }

  const user = upsertGoogleUser({
    googleSub: profile.sub,
    email: profile.email,
    name: profile.name,
    avatarUrl: profile.picture ?? null,
  });

  const role = isAdminEmail(user.email) ? 'admin' : 'user';
  const sessionToken = await createSessionToken(user.id, role);
  const response = NextResponse.redirect(buildAppUrl('/', req));
  response.cookies.set(APP_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  response.cookies.set(GOOGLE_STATE_COOKIE, '', clearSessionCookieOptions());
  return response;
}
