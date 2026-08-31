import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { parseDocumentFile, type DocumentFileInput } from '@/lib/store/prospect-store';
import { deleteAttachment } from '@/lib/services/r2-attachments';
import { FIXED_DOCUMENT_TYPES, type ProspectDocumentType } from '@/lib/models/prospect';

type Ctx = { params: Promise<{ prospectId: string; documentId: string }> };

const VALID_TYPES: ProspectDocumentType[] = [...FIXED_DOCUMENT_TYPES, 'other'];

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { prospectId, documentId } = await params;
  const store = getProspectStore();
  const body = await req.json() as {
    type?:  unknown;
    url?:   unknown;
    title?: unknown;
    file?:  unknown;
  };

  const file = parseDocumentFile(prospectId, body.file);
  if (file === 'invalid') {
    return NextResponse.json({ error: 'Invalid uploaded file reference.' }, { status: 400 });
  }

  const patch: { type?: ProspectDocumentType; url?: string; title?: string | null; file?: DocumentFileInput | null } = {};
  if (typeof body.type === 'string' && VALID_TYPES.includes(body.type as ProspectDocumentType)) {
    patch.type = body.type as ProspectDocumentType;
  }
  if (typeof body.title === 'string') patch.title = body.title.trim() || null;
  // A file replaces a link (and vice-versa); the store clears the other's fields.
  if (file) patch.file = file;
  else if (typeof body.url === 'string' && body.url.trim()) patch.url = body.url.trim();

  // Capture the prior file key before the update so we can reclaim its R2 object
  // if this edit swaps the file out (new file, or a link replacing the file).
  const previous = store.getDocumentById(documentId);
  const updated  = store.updateDocument(documentId, patch);
  if (!updated) return NextResponse.json({ error: 'Document not found.' }, { status: 404 });

  if (previous?.fileKey && previous.fileKey !== updated.fileKey) {
    void deleteAttachment(previous.fileKey);
  }

  return NextResponse.json({ document: updated });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { documentId } = await params;
  const store = getProspectStore();

  // Reclaim the R2 object (if any) before dropping the record.
  const existing = store.getDocumentById(documentId);
  const deleted  = store.deleteDocument(documentId);
  if (!deleted) return NextResponse.json({ error: 'Document not found.' }, { status: 404 });

  if (existing?.fileKey) void deleteAttachment(existing.fileKey);

  return NextResponse.json({ ok: true });
}
