import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess, getSession } from '@/lib/services/api-auth';
import { getProspectStore, getClientStore, getProjectStore } from '@/lib/services/container';
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

  const body = await req.json() as { clientName?: unknown; existingClientId?: unknown };

  function notifyAssigned(company: string) {
    const actor   = getUserById(session!.userId);
    const targets = existing!.assignedTo.filter((id) => id !== session!.userId);
    void Promise.allSettled(
      targets.map((userId) =>
        notifyProspectEvent({
          userId,
          type:       'promoted',
          prospectId,
          company,
          fromUserId: session!.userId,
          fromName:   actor?.name,
        }),
      ),
    );
  }

  // ── Path A: fold into an existing parent client ──────────────────────────
  if (typeof body.existingClientId === 'string' && body.existingClientId.trim()) {
    const clientStore  = getClientStore();
    const targetClient = clientStore.getAll().find((c) => c.clientId === body.existingClientId);
    if (!targetClient) return NextResponse.json({ error: 'Target client not found.' }, { status: 404 });

    const promoted = store.promote(prospectId, targetClient.name, session!.userId);
    if (!promoted) return NextResponse.json({ error: 'Promotion failed.' }, { status: 500 });

    // Mark the target client as a parent org (idempotent).
    clientStore.setAsParent(targetClient.clientId);

    // Auto-create a project on the Projects page for this engagement.
    try {
      getProjectStore().create(
        { name: existing.company, clientName: targetClient.name },
        { source_kind: 'api' },
      );
    } catch (err) {
      console.warn('[promote] project auto-create skipped:', (err as Error).message);
    }

    notifyAssigned(existing.company);
    return NextResponse.json({ prospect: promoted });
  }

  // ── Path B: create a new standalone client ────────────────────────────────
  const clientName = typeof body.clientName === 'string' ? body.clientName.trim() : '';
  if (!clientName) return NextResponse.json({ error: 'Client name is required.' }, { status: 400 });

  const promoted = store.promote(prospectId, clientName, session!.userId);
  if (!promoted) return NextResponse.json({ error: 'Promotion failed.' }, { status: 500 });

  getClientStore().upsertForProspect(prospectId, clientName, session!.userId);

  // Auto-create a project on the Projects page for this engagement.
  try {
    getProjectStore().create(
      { name: existing.company, clientName },
      { source_kind: 'api' },
    );
  } catch (err) {
    console.warn('[promote] project auto-create skipped:', (err as Error).message);
  }

  notifyAssigned(existing.company);
  return NextResponse.json({ prospect: promoted });
}
