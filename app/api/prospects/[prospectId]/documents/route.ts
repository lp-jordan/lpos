import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { parseDocumentFile } from '@/lib/store/prospect-store';
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
    file?:  unknown;
  };

  const type = body.type as ProspectDocumentType;
  if (!type || !VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: 'A valid document type is required.' }, { status: 400 });
  }

  const file = parseDocumentFile(prospectId, body.file);
  if (file === 'invalid') {
    return NextResponse.json({ error: 'Invalid uploaded file reference.' }, { status: 400 });
  }

  // A document is either an uploaded file or a link — exactly one is required.
  if (!file && (!body.url || typeof body.url !== 'string' || !body.url.trim())) {
    return NextResponse.json({ error: 'A document link or uploaded file is required.' }, { status: 400 });
  }

  const document = store.addDocument(prospectId, {
    type,
    url:   typeof body.url === 'string' ? body.url.trim() : undefined,
    title: typeof body.title === 'string' ? body.title.trim() || null : null,
    file,
  });

  return NextResponse.json({ document }, { status: 201 });
}
