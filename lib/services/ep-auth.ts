import { NextRequest, NextResponse } from 'next/server';

/**
 * Verify that the request carries the shared EditPanel secret.
 *
 * The client sends `X-EP-Secret: <secret>` on every request.
 * The server checks it against the EP_SHARED_SECRET env var (set in Doppler on both sides).
 *
 * Returns null on success (caller proceeds); returns a NextResponse on auth failure.
 */
export function requireEpSecret(req: NextRequest): NextResponse | null {
  const secret = process.env.EP_SHARED_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: 'EditPanel authentication not configured on this server' },
      { status: 503 },
    );
  }

  const provided = req.headers.get('x-ep-secret')?.trim();
  if (!provided || provided !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
