import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getPassTree, updatePass, deletePass, setPassClient, setPassPinned, getPass, type PassPatch } from '@/lib/store/platform-pass-store';
import { listClientNames } from '@/lib/platform/pass-clients';

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
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { passId } = await params;
  const { clientName, pinned, ...patch } = (await req.json().catch(() => ({}))) as PassPatch & {
    clientName?: string | null;
    pinned?: boolean;
  };
  if (!getPass(passId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Organisational fields (client, pin) are applied without bumping updated_at,
  // so they don't reshuffle the gallery's Recent sort.
  if (clientName !== undefined) {
    const name = clientName?.trim() || null;
    if (name && !listClientNames().includes(name)) {
      return NextResponse.json({ error: `Unknown client: ${name}` }, { status: 400 });
    }
    setPassClient(passId, name);
  }
  if (typeof pinned === 'boolean') setPassPinned(passId, pinned, session.userId);

  const pass = Object.keys(patch).length > 0 ? updatePass(passId, patch) : getPass(passId);
  if (!pass) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ pass });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ passId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { passId } = await params;
  deletePass(passId);
  return NextResponse.json({ ok: true });
}
