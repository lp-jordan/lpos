/**
 * POST /api/ep-updates/config
 *
 * Sets the directory that EpReleaseService watches for new electron-builder output
 * (the shared NAS folder the Windows build writes to). Admin only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getEpReleaseService } from '@/lib/services/container';

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (session?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { watchDir?: string };
  try { body = await req.json() as { watchDir?: string }; }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  if (typeof body.watchDir !== 'string' || !body.watchDir.trim()) {
    return NextResponse.json({ error: '"watchDir" required' }, { status: 400 });
  }

  const svc = getEpReleaseService();
  if (!svc) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });

  svc.setWatchDir(body.watchDir.trim());
  return NextResponse.json({ ok: true, status: svc.getStatus() });
}

export async function GET() {
  const svc = getEpReleaseService();
  if (!svc) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  return NextResponse.json(svc.getStatus());
}
