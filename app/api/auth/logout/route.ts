import { NextResponse } from 'next/server';
import { buildAppUrl } from '@/lib/services/app-origin';
import { APP_SESSION_COOKIE, clearSessionCookieOptions } from '@/lib/services/session-auth';

export async function POST(req: Request) {
  const response = NextResponse.redirect(buildAppUrl('/signin'));
  response.cookies.set(APP_SESSION_COOKIE, '', clearSessionCookieOptions());
  return response;
}
