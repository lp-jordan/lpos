import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { fetchAttachment } from '@/lib/services/r2-attachments';

export async function GET(req: NextRequest) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const key = req.nextUrl.searchParams.get('key') ?? '';
  if (!key.startsWith('attachments/') || key.includes('..')) {
    return NextResponse.json({ error: 'Invalid key.' }, { status: 400 });
  }

  const result = await fetchAttachment(key);
  if (!result) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const isInline = result.contentType.startsWith('image/') || result.contentType === 'application/pdf';

  return new NextResponse(result.bytes, {
    headers: {
      'Content-Type':  result.contentType,
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': isInline ? 'inline' : 'attachment',
    },
  });
}
