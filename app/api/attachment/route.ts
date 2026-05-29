import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getSession, requireProspectsAccess } from '@/lib/services/api-auth';
import { fetchAttachment } from '@/lib/services/r2-attachments';

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key') ?? '';
  if (!key.startsWith('attachments/') || key.includes('..')) {
    return NextResponse.json({ error: 'Invalid key.' }, { status: 400 });
  }

  // Authorize by attachment type. Keys are minted server-side on upload, so the
  // prefix is a trusted discriminator: task attachments require only a valid
  // session (matching task-comment uploads), while prospect attachments require
  // Prospects access (matching prospect-update uploads).
  if (key.startsWith('attachments/tasks/')) {
    const session = await getSession(req);
    if (!session) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  } else {
    const deny = await requireProspectsAccess(req);
    if (deny) return deny;
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
