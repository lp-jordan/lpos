import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { uploadAttachment } from '@/lib/services/r2-attachments';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

type Ctx = { params: Promise<{ prospectId: string }> };

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
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File exceeds 10 MB limit.' }, { status: 413 });
  }

  const ext    = path.extname(file.name).toLowerCase();
  const key    = `attachments/${prospectId}/${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const mime   = file.type || 'application/octet-stream';

  await uploadAttachment(key, buffer, mime);

  return NextResponse.json({ key, name: file.name, mime, size: file.size }, { status: 201 });
}
