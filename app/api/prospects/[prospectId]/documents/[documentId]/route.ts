import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { FIXED_DOCUMENT_TYPES, type ProspectDocumentType } from '@/lib/models/prospect';

type Ctx = { params: Promise<{ prospectId: string; documentId: string }> };

const VALID_TYPES: ProspectDocumentType[] = [...FIXED_DOCUMENT_TYPES, 'other'];

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { documentId } = await params;
  const body = await req.json() as {
    type?:  unknown;
    url?:   unknown;
    title?: unknown;
  };

  const patch: { type?: ProspectDocumentType; url?: string; title?: string | null } = {};
  if (typeof body.type === 'string' && VALID_TYPES.includes(body.type as ProspectDocumentType)) {
    patch.type = body.type as ProspectDocumentType;
  }
  if (typeof body.url === 'string' && body.url.trim()) patch.url = body.url.trim();
  if (typeof body.title === 'string') patch.title = body.title.trim() || null;

  const updated = getProspectStore().updateDocument(documentId, patch);
  if (!updated) return NextResponse.json({ error: 'Document not found.' }, { status: 404 });

  return NextResponse.json({ document: updated });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { documentId } = await params;
  const deleted = getProspectStore().deleteDocument(documentId);
  if (!deleted) return NextResponse.json({ error: 'Document not found.' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
