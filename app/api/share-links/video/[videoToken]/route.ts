/**
 * GET /api/share-links/video/:videoToken → the viewer model for /v/:videoToken
 *
 * A single-video reshare link: playback only, one video. Revoking the share,
 * turning its Reshare off, or removing the video kills the link.
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
  // Playback only: never hand back the parent share's token or name (the token
  // would open the whole share), and switch every extra off.
  return NextResponse.json({
    share:  { id: '', token: '', name: item.title, passId: null, audience: 'link', caps: { comments: false, download: false, reshare: false, transcripts: false, internal: false } },
    groups: [{ title: null, items: [{ ...item, lposName: item.title, clientTitle: null }] }],
  });
}
