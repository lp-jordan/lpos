/**
 * GET /api/share-links/video/:videoToken → the viewer model for /v/:videoToken
 *
 * A single-video reshare link: the parent share's settings, narrowed to one
 * video. Revoking the share revokes every per-video link inside it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getShareItemByVideoToken } from '@/lib/store/share-links-db';
import { resolveShareView } from '@/lib/services/share-links';

type Ctx = { params: Promise<{ videoToken: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { videoToken } = await params;
  const hit = getShareItemByVideoToken(videoToken);
  if (!hit || hit.share.revokedAt || !hit.share.caps.reshare) {
    return NextResponse.json({ error: 'This link is no longer available.' }, { status: 410 });
  }
  const view = resolveShareView(hit.share);
  const item = view.groups.flatMap((g) => g.items).find((i) => i.assetId === hit.item.assetId);
  if (!item) return NextResponse.json({ error: 'This link is no longer available.' }, { status: 410 });
  return NextResponse.json({ ...view, groups: [{ title: null, items: [item] }] });
}
