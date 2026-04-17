import { NextRequest, NextResponse } from 'next/server';
import { buildAppUrl } from '@/lib/services/app-origin';
import { APP_SESSION_COOKIE, clearSessionCookieOptions } from '@/lib/services/session-auth';

function logoutResponse(req: NextRequest): NextResponse {
  const response = NextResponse.redirect(buildAppUrl('/signin', req));
  response.cookies.set(APP_SESSION_COOKIE, '', clearSessionCookieOptions());
  return response;
}

export async function POST(req: NextRequest) {
  return logoutResponse(req);
}

export async function GET(req: NextRequest) {
  return logoutResponse(req);
}
