import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, createSessionToken, getSessionCookieOptions } from '@/lib/services/session-auth';
import { getOrCreateGuestUser } from '@/lib/store/user-store';
import { verifyGuestPin } from '@/lib/services/guest-pin';

// In-memory rate limiter: max 5 failed attempts per IP per 15 minutes.
// Resets on a successful login so legitimate users are never locked out.
const failedAttempts = new Map<string, { count: number; windowStart: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  if (checkRateLimit(ip)) {
    return NextResponse.json(
      { error: 'Too many incorrect attempts. Try again in 15 minutes.' },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => ({})) as { pin?: string };

  if (!verifyGuestPin(body.pin ?? '')) {
    recordFailure(ip);
    return NextResponse.json({ error: 'Incorrect PIN. Ask an operator for today\'s code.' }, { status: 401 });
  }

  // Clear any recorded failures on success so the window resets cleanly.
  failedAttempts.delete(ip);

  const guest = getOrCreateGuestUser();
  const token = await createSessionToken(guest.id, 'guest');
  const cookieStore = await cookies();
  cookieStore.set(APP_SESSION_COOKIE, token, getSessionCookieOptions());
  return NextResponse.json({ ok: true });
}
