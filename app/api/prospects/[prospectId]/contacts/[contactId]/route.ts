import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import type { ProspectContact } from '@/lib/models/prospect';

type Ctx = { params: Promise<{ prospectId: string; contactId: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { contactId } = await params;
  const body = await req.json() as {
    name?:     unknown;
    role?:     unknown;
    email?:    unknown;
    phone?:    unknown;
    linkedin?: unknown;
  };

  const patch: Partial<Pick<ProspectContact, 'name' | 'role' | 'email' | 'phone' | 'linkedin'>> = {};
  if (typeof body.name     === 'string') patch.name     = body.name;
  if (typeof body.role     === 'string') patch.role     = body.role     || null;
  if (typeof body.email    === 'string') patch.email    = body.email    || null;
  if (typeof body.phone    === 'string') patch.phone    = body.phone    || null;
  if (typeof body.linkedin === 'string') patch.linkedin = body.linkedin || null;

  const updated = getProspectStore().updateContact(contactId, patch);
  if (!updated) return NextResponse.json({ error: 'Contact not found.' }, { status: 404 });

  return NextResponse.json({ contact: updated });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { contactId } = await params;
  const deleted = getProspectStore().deleteContact(contactId);
  if (!deleted) return NextResponse.json({ error: 'Contact not found.' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
