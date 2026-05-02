import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess, getSession } from '@/lib/services/api-auth';
import { getProspectStore, getClientStore } from '@/lib/services/container';
import { notifyProspectEvent } from '@/lib/services/prospect-notification-service';
import { getUserById } from '@/lib/store/user-store';


type Ctx = { params: Promise<{ prospectId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const session = await getSession(req);
  const { prospectId } = await params;
  const store = getProspectStore();

  const existing = store.getById(prospectId);
  if (!existing) return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  if (existing.status === 'active') return NextResponse.json({ error: 'Already an active client.' }, { status: 409 });

  const body = await req.json() as { clientName?: unknown };
  const clientName = typeof body.clientName === 'string' ? body.clientName.trim() : '';
  if (!clientName) return NextResponse.json({ error: 'Client name is required.' }, { status: 400 });

  const promoted = store.promote(prospectId, clientName, session!.userId);
  if (!promoted) return NextResponse.json({ error: 'Promotion failed.' }, { status: 500 });

  getClientStore().upsertForProspect(prospectId, clientName, session!.userId);

  // Notify all assigned users
  const actor   = getUserById(session!.userId);
  const targets = existing.assignedTo.filter((id) => id !== session!.userId);
  void Promise.allSettled(
    targets.map((userId) =>
      notifyProspectEvent({
        userId,
        type:       'promoted',
        prospectId,
        company:    existing.company,
        fromUserId: session!.userId,
        fromName:   actor?.name,
      }),
    ),
  );

  return NextResponse.json({ prospect: promoted });
}
