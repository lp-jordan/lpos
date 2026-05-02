import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess, getSession } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { notifyProspectEvent } from '@/lib/services/prospect-notification-service';
import { getUserById } from '@/lib/store/user-store';

type Ctx = { params: Promise<{ prospectId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { prospectId } = await params;
  const store    = getProspectStore();
  const prospect = store.getById(prospectId);
  if (!prospect) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const contacts      = store.getContacts(prospectId);
  const statusHistory = store.getStatusHistory(prospectId);

  return NextResponse.json({ prospect, contacts, statusHistory });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const session = await getSession(req);
  const { prospectId } = await params;
  const store = getProspectStore();

  if (!store.getById(prospectId)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const body = await req.json() as Record<string, unknown>;

  // Archive/unarchive
  if (typeof body.archived === 'boolean') {
    body.archived ? store.archive(prospectId) : store.unarchive(prospectId);
    return NextResponse.json({ prospect: store.getById(prospectId) });
  }

  const before = store.getById(prospectId)!;
  const patch: Parameters<typeof store.update>[1] = {};

  const str = (k: string) => typeof body[k] === 'string' ? (body[k] as string) || null : undefined;
  const num = (k: string) => typeof body[k] === 'number' ? (body[k] as number) : (body[k] === null ? null : undefined);

  if (typeof body.company  === 'string') patch.company  = body.company;
  if (typeof body.website  === 'string') patch.website  = body.website  || null;
  if (typeof body.industry === 'string') patch.industry = body.industry || null;
  if (str('source')               !== undefined) patch.source               = str('source')!;
  if (str('status')               !== undefined) patch.status               = body.status as never;
  if (str('accountModel')         !== undefined) patch.accountModel         = str('accountModel')!;
  if (str('revenueType')          !== undefined) patch.revenueType          = str('revenueType')!;
  if (str('expansionPotential')   !== undefined) patch.expansionPotential   = str('expansionPotential')!;
  if (str('expectedStartMonth')   !== undefined) patch.expectedStartMonth   = str('expectedStartMonth')!;
  if (str('owner')                !== undefined) patch.owner                = str('owner')!;
  if (str('startMonth')           !== undefined) patch.startMonth           = str('startMonth')!;
  if (str('recurringBillingStatus') !== undefined) patch.recurringBillingStatus = str('recurringBillingStatus')!;
  if (str('renewalDate')          !== undefined) patch.renewalDate          = str('renewalDate')!;
  if (str('firstRecurringBillDate') !== undefined) patch.firstRecurringBillDate = str('firstRecurringBillDate')!;
  if (str('activeServices')       !== undefined) patch.activeServices       = str('activeServices')!;
  if (str('nextFilmDate')         !== undefined) patch.nextFilmDate         = str('nextFilmDate')!;

  const oneTime = num('oneTimeLpRevenue');
  if (oneTime !== undefined) patch.oneTimeLpRevenue = oneTime;
  const monthly = num('monthlyLpRevenue');
  if (monthly !== undefined) patch.monthlyLpRevenue = monthly;
  const tech = num('monthlyLpTechRevenue');
  if (tech !== undefined) patch.monthlyLpTechRevenue = tech;
  const fye = num('estimatedFirstYearValue');
  if (fye !== undefined) patch.estimatedFirstYearValue = fye;

  const updated = store.update(prospectId, patch, session!.userId);

  if (patch.status && patch.status !== before.status) {
    const actor   = getUserById(session!.userId);
    const targets = before.assignedTo.filter((id) => id !== session!.userId);
    void Promise.allSettled(
      targets.map((userId) =>
        notifyProspectEvent({
          userId,
          type:       'status_changed',
          prospectId,
          company:    before.company,
          fromUserId: session!.userId,
          fromName:   actor?.name,
        }),
      ),
    );
  }

  return NextResponse.json({ prospect: updated });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { prospectId } = await params;
  const store = getProspectStore();

  const existing = store.getById(prospectId);
  if (!existing) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (existing.status === 'active') {
    return NextResponse.json({ error: 'Cannot delete an active client.' }, { status: 409 });
  }

  store.deleteProspect(prospectId);
  return NextResponse.json({ ok: true });
}
