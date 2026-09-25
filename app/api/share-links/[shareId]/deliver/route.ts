/**
 * POST /api/share-links/:shareId/deliver
 *   Locks every video to its current version, turns downloads on and closes
 *   comments. The URL doesn't change.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getShareLink } from '@/lib/store/share-links-db';
import { deliverShare } from '@/lib/services/share-links';

type Ctx = { params: Promise<{ shareId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { shareId } = await params;
  const share = getShareLink(shareId);
  if (!share) return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  return NextResponse.json({ share: deliverShare(share) });
}
