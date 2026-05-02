import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess, getSession } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { notifyProspectEvent } from '@/lib/services/prospect-notification-service';
import { getUserById } from '@/lib/store/user-store';

type Ctx = { params: Promise<{ prospectId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const session = await getSession(req);
  const { prospectId } = await params;
  const body = await req.json() as { userId?: unknown };

  if (!body.userId || typeof body.userId !== 'string') {
    return NextResponse.json({ error: 'userId is required.' }, { status: 400 });
  }

  const store = getProspectStore();
  const prospect = store.getById(prospectId);
  if (!prospect) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  store.addUser(prospectId, body.userId);

  // Notify the assigned user (skip if they assigned themselves)
  if (body.userId !== session!.userId) {
    const actor = getUserById(session!.userId);
    void notifyProspectEvent({
      userId:     body.userId,
      type:       'assigned',
      prospectId,
      company:    prospect.company,
      fromUserId: session!.userId,
      fromName:   actor?.name,
    });
  }

  return NextResponse.json({ prospect: store.getById(prospectId) });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { prospectId } = await params;
  const body = await req.json() as { userId?: unknown };

  if (!body.userId || typeof body.userId !== 'string') {
    return NextResponse.json({ error: 'userId is required.' }, { status: 400 });
  }

  getProspectStore().removeUser(prospectId, body.userId);
  return NextResponse.json({ prospect: getProspectStore().getById(prospectId) });
}
