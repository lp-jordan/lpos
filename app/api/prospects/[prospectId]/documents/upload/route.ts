import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { uploadAttachment } from '@/lib/services/r2-attachments';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

type Ctx = { params: Promise<{ prospectId: string }> };

/**
 * Uploads a document file (PDF) to R2 and returns the metadata the caller then
 * POSTs to the documents route to create/attach the record. Mirrors the
 * update-attachments upload flow; keys share the `attachments/` prefix so the
 * /api/attachment serve route authorizes them under Prospects access.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { prospectId } = await params;
  if (!getProspectStore().getById(prospectId)) {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
  }

  const mime = file.type || 'application/octet-stream';
  const isPdf = mime === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    return NextResponse.json({ error: 'Only PDF files are supported.' }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File exceeds 25 MB limit.' }, { status: 413 });
  }

  const key    = `attachments/${prospectId}/documents/${randomUUID()}.pdf`;
  const buffer = Buffer.from(await file.arrayBuffer());

  await uploadAttachment(key, buffer, 'application/pdf');

  return NextResponse.json({ key, name: file.name, mime: 'application/pdf', size: file.size }, { status: 201 });
}
