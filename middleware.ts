import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { GUEST_USER_ID } from '@/lib/models/user';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isPublicPath(pathname: string): boolean {
  if (pathname === '/signin') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname === '/favicon.ico') return true;
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith('/api/')) {
    // Block mutating requests from guest sessions (auth routes are exempt)
    if (MUTATING_METHODS.has(req.method) && !pathname.startsWith('/api/auth/')) {
      const session = await verifySessionToken(req.cookies.get(APP_SESSION_COOKIE)?.value);
      if (session?.userId === GUEST_USER_ID) {
        return NextResponse.json(
          { error: 'Guest accounts are view-only.' },
          { status: 403 },
        );
      }
    }
    return NextResponse.next();
  }

  if (isPublicPath(pathname)) {
    if (pathname === '/signin') {
      const session = await verifySessionToken(req.cookies.get(APP_SESSION_COOKIE)?.value);
      if (session) {
        return NextResponse.redirect(new URL('/', req.url));
      }
    }
    return NextResponse.next();
  }

  const session = await verifySessionToken(req.cookies.get(APP_SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  const signInUrl = new URL('/signin', req.url);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: '/:path*',
};
