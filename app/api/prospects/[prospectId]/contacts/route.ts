import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';

type Ctx = { params: Promise<{ prospectId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { prospectId } = await params;
  const contacts = getProspectStore().getContacts(prospectId);
  return NextResponse.json({ contacts });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { prospectId } = await params;
  const store = getProspectStore();

  if (!store.getById(prospectId)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const body = await req.json() as {
    name?:     unknown;
    role?:     unknown;
    email?:    unknown;
    phone?:    unknown;
    linkedin?: unknown;
  };

  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'Contact name is required.' }, { status: 400 });
  }

  const contact = store.addContact(prospectId, {
    name:     body.name,
    role:     typeof body.role     === 'string' ? body.role     || null : null,
    email:    typeof body.email    === 'string' ? body.email    || null : null,
    phone:    typeof body.phone    === 'string' ? body.phone    || null : null,
    linkedin: typeof body.linkedin === 'string' ? body.linkedin || null : null,
  });

  return NextResponse.json({ contact }, { status: 201 });
}
