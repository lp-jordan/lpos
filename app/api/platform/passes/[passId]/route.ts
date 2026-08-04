import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getPassTree, updatePass, deletePass, type PassStatus } from '@/lib/store/platform-pass-store';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ passId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { passId } = await params;
  const pass = getPassTree(passId);
  if (!pass) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ pass });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ passId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { passId } = await params;
  const body = (await req.json().catch(() => ({}))) as { title?: string; status?: PassStatus; brand?: string };
  const pass = updatePass(passId, body);
  if (!pass) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ pass });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ passId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { passId } = await params;
  deletePass(passId);
  return NextResponse.json({ ok: true });
}
