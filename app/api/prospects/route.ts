import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess, getSession } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';

export async function GET(req: NextRequest) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const session = await getSession(req);
  const { searchParams } = req.nextUrl;
  const scope           = searchParams.get('scope') ?? 'all';
  const includeArchived = searchParams.get('includeArchived') === 'true';

  const store     = getProspectStore();
  const prospects = scope === 'mine'
    ? store.getForUser(session!.userId, { includeArchived })
    : store.getAll({ includeArchived });

  return NextResponse.json({ prospects });
}

export async function POST(req: NextRequest) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const session = await getSession(req);
  const body = await req.json() as {
    company?:      unknown;
    website?:      unknown;
    industry?:     unknown;
    source?:       unknown;
    accountModel?: unknown;
    assignedTo?:   unknown;
    openingNote?:  unknown;
  };

  if (!body.company || typeof body.company !== 'string' || !body.company.trim()) {
    return NextResponse.json({ error: 'Company name is required.' }, { status: 400 });
  }

  const store    = getProspectStore();
  const prospect = store.create({
    company:      body.company,
    website:      typeof body.website === 'string' ? body.website : null,
    industry:     typeof body.industry === 'string' ? body.industry : null,
    source:       typeof body.source === 'string' ? body.source : null,
    accountModel: typeof body.accountModel === 'string' ? body.accountModel : null,
    assignedTo:   Array.isArray(body.assignedTo) ? (body.assignedTo as string[]) : undefined,
    createdBy:    session!.userId,
  });

  if (typeof body.openingNote === 'string' && body.openingNote.trim()) {
    store.addUpdate(prospect.prospectId, session!.userId, body.openingNote.trim());
  }

  return NextResponse.json({ prospect }, { status: 201 });
}
