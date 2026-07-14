import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { getFileThumbnail } from '@/lib/services/drive-client';

type Ctx = { params: Promise<{ prospectId: string; documentId: string }> };

/**
 * Proxy a document's Google Drive thumbnail. Only resolves when the linked file
 * lives in the Shared Team Drive the service account can read; otherwise (or on
 * any Drive error / missing config) returns 404 and the cover falls back to the
 * generated placeholder. Bytes are served with a short private cache.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { prospectId, documentId } = await params;

  const doc = getProspectStore().getDocuments(prospectId).find((d) => d.documentId === documentId);
  if (!doc || !doc.fileId) {
    return NextResponse.json({ error: 'No thumbnail.' }, { status: 404 });
  }

  try {
    const thumb = await getFileThumbnail(doc.fileId);
    if (!thumb) return NextResponse.json({ error: 'No thumbnail.' }, { status: 404 });

    return new NextResponse(new Uint8Array(thumb.buffer), {
      status: 200,
      headers: {
        'Content-Type':  thumb.contentType,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return NextResponse.json({ error: 'No thumbnail.' }, { status: 404 });
  }
}
