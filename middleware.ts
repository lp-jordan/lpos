import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';

// ── Machine-client bearer token (LeaderPrompt) ────────────────────────────────

function hasMachineToken(req: NextRequest): boolean {
  const lpToken = process.env.LPOS_LP_TOKEN?.trim();
  if (!lpToken) return false;
  const auth = req.headers.get('authorization') ?? '';
  const [scheme, token] = auth.split(' ');
  return scheme === 'Bearer' && token === lpToken;
}

// ── Public paths — no session required ───────────────────────────────────────

function isPublicPath(pathname: string): boolean {
  if (pathname === '/signin') return true;
  if (pathname === '/guest-pin') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname === '/favicon.ico') return true;
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return true;
  return false;
}

// ── Guest allow-list — the only paths a guest session may access ──────────────
// Pages: /guest, /guest/scripts, /slate, /projects/[id]/scripts
// API:   /api/presentation/*, /api/studio/lighting/*, /api/studio/wled/*, /api/projects/[id]/scripts (GET + POST only)

function isGuestAllowed(pathname: string, method: string): boolean {
  if (pathname === '/guest') return true;
  if (pathname === '/guest/scripts') return true;
  if (pathname === '/slate') return true;
  if (pathname.startsWith('/api/presentation/')) return true;
  if (pathname.startsWith('/api/studio/lighting')) return true;
  if (pathname.startsWith('/api/studio/wled')) return true;
  if (/^\/projects\/[^/]+\/scripts$/.test(pathname)) return true;
  // Script upload: allow GET (list) and POST (upload) but not DELETE
  if (/^\/api\/projects\/[^/]+\/scripts$/.test(pathname) && (method === 'GET' || method === 'POST')) return true;
  return false;
}

// ── Middleware ────────────────────────────────────────────────────────────────

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) {
    // Redirect already-authenticated users away from /signin
    if (pathname === '/signin') {
      const session = await verifySessionToken(req.cookies.get(APP_SESSION_COOKIE)?.value);
      if (session) {
        const dest = session.role === 'guest' ? '/guest' : '/';
        return NextResponse.redirect(new URL(dest, req.url));
      }
    }
    return NextResponse.next();
  }

  // Machine clients (LeaderPrompt) skip cookie auth
  if (hasMachineToken(req)) return NextResponse.next();

  const session = await verifySessionToken(req.cookies.get(APP_SESSION_COOKIE)?.value);

  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/signin', req.url));
  }

  // ── Guest restrictions ────────────────────────────────────────────────────
  if (session.role === 'guest') {
    if (isGuestAllowed(pathname, req.method)) return NextResponse.next();
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'You do not have permission to do that.' }, { status: 403 });
    }
    // Page request outside the allow-list → send them home with a notice
    return NextResponse.redirect(new URL('/guest?blocked=1', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/:path*',
};
