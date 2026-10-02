/**
 * GET /api/share-links/:shareId/activity → { activity }
 * Who has opened the share, video-link opens and downloads — read live from
 * LP Share, which records them (staff visits and link previews excluded).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getShareLink } from '@/lib/store/share-links-db';
import { fetchShareActivity } from '@/lib/services/share-app';

type Ctx = { params: Promise<{ shareId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { shareId } = await params;
  if (!getShareLink(shareId)) return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  try {
    return NextResponse.json({ activity: await fetchShareActivity(shareId) });
  } catch (err) {
    const msg = (err as Error).message;
    // Not pushed to LP Share yet (brand new share) → nothing has happened.
    if (/→ 404/.test(msg)) return NextResponse.json({ activity: null });
    return NextResponse.json({ error: 'Could not reach LP Share' }, { status: 502 });
  }
}
