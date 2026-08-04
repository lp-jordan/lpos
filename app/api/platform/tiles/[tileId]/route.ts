import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { updateTile, regenerateTile, deleteTile, type TilePatch } from '@/lib/store/platform-pass-store';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ tileId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { tileId } = await params;
  const body = (await req.json().catch(() => ({}))) as (TilePatch & { regenerate?: boolean });
  const tile = body.regenerate
    ? regenerateTile(tileId)
    : updateTile(tileId, body);
  if (!tile) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ tile });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ tileId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { tileId } = await params;
  deleteTile(tileId);
  return NextResponse.json({ ok: true });
}
