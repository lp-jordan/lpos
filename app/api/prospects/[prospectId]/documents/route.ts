import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { FIXED_DOCUMENT_TYPES, type ProspectDocumentType } from '@/lib/models/prospect';

type Ctx = { params: Promise<{ prospectId: string }> };

const VALID_TYPES: ProspectDocumentType[] = [...FIXED_DOCUMENT_TYPES, 'other'];

export async function GET(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { prospectId } = await params;
  const documents = getProspectStore().getDocuments(prospectId);
  return NextResponse.json({ documents });
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
    type?:  unknown;
    url?:   unknown;
    title?: unknown;
  };

  const type = body.type as ProspectDocumentType;
  if (!type || !VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: 'A valid document type is required.' }, { status: 400 });
  }
  if (!body.url || typeof body.url !== 'string' || !body.url.trim()) {
    return NextResponse.json({ error: 'A document URL is required.' }, { status: 400 });
  }

  const document = store.addDocument(prospectId, {
    type,
    url:   body.url.trim(),
    title: typeof body.title === 'string' ? body.title.trim() || null : null,
  });

  return NextResponse.json({ document }, { status: 201 });
}
