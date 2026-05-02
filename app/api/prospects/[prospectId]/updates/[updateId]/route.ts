import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess, getSession } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';

type Ctx = { params: Promise<{ prospectId: string; updateId: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const session = await getSession(req);
  const { updateId } = await params;
  const store   = getProspectStore();

  // Only allow author to edit
  const existing = store.getUpdates((await params).prospectId).find((u) => u.updateId === updateId);
  if (!existing) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (existing.authorId !== session!.userId) {
    return NextResponse.json({ error: 'You can only edit your own updates.' }, { status: 403 });
  }

  const body = await req.json() as { body?: unknown };
  if (!body.body || typeof body.body !== 'string' || !body.body.trim()) {
    return NextResponse.json({ error: 'Update body is required.' }, { status: 400 });
  }

  const updated = store.editUpdate(updateId, body.body.trim());
  return NextResponse.json({ update: updated });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const session = await getSession(req);
  const { prospectId, updateId } = await params;
  const store = getProspectStore();

  const existing = store.getUpdates(prospectId).find((u) => u.updateId === updateId);
  if (!existing) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (existing.authorId !== session!.userId) {
    return NextResponse.json({ error: 'You can only delete your own updates.' }, { status: 403 });
  }

  store.deleteUpdate(updateId);
  return NextResponse.json({ ok: true });
}
