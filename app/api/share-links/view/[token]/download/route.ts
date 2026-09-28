/**
 * GET /api/share-links/view/:token/download?assetId=&kind=original|web|srt|vtt|txt
 *   → 302 to a 4-hour presigned R2 URL. Clients download straight from R2
 *   (free egress); LPOS never streams the file.
 *
 * Staff-session gated for now, like the viewer; the public app will do the same
 * checks and presign itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getShareLinkByToken, listShareItems } from '@/lib/store/share-links-db';
import { resolveShareView } from '@/lib/services/share-links';
import { readyDownloadFile, type DownloadKind } from '@/lib/services/share-downloads';
import { presignR2Get, sanitizeFilename } from '@/lib/services/share-r2';

type Ctx = { params: Promise<{ token: string }> };
const KINDS: DownloadKind[] = ['original', 'web', 'srt', 'vtt', 'txt'];

export async function GET(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { token } = await params;
  const sp = new URL(req.url).searchParams;
  const assetId = sp.get('assetId') ?? '';
  const kind = (sp.get('kind') ?? 'original') as DownloadKind;
  if (!KINDS.includes(kind)) return NextResponse.json({ error: 'Unknown download type' }, { status: 400 });

  const share = getShareLinkByToken(token);
  if (!share || share.revokedAt) return NextResponse.json({ error: 'This link is no longer available.' }, { status: 410 });
  if (!share.caps.download) return NextResponse.json({ error: 'Downloads are off for this share.' }, { status: 403 });
  if (!listShareItems(share.id).some((i) => i.assetId === assetId)) return NextResponse.json({ error: 'Video not in this share' }, { status: 404 });

  const file = readyDownloadFile(assetId, kind);
  if (!file) return NextResponse.json({ error: 'This download is still being prepared.' }, { status: 409 });

  // Save under the title the share shows (tile / custom title), not the LPOS file name.
  const item = resolveShareView(share).groups.flatMap((g) => g.items).find((i) => i.assetId === assetId);
  // Titles that are raw file names already carry an extension — don't double it.
  const title = sanitizeFilename((item?.title ?? 'video').replace(/\.(mp4|mov|m4v|mxf|mkv|webm|avi)$/i, ''));
  const filename = kind === 'web' ? `${title} (web).mp4` : `${title}${file.ext}`;
  return NextResponse.redirect(presignR2Get(file.key, filename), { status: 302, headers: { 'Cache-Control': 'no-store' } });
}
