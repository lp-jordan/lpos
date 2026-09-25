/**
 * GET /api/share-links/view/:token  → the viewer model for /s/:token
 *
 * Staff-session gated for now: the in-LPOS prototype only serves signed-in
 * staff. The public share.leaderpass.com app will serve clients later.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getShareLinkByToken } from '@/lib/store/share-links-db';
import { resolveShareView } from '@/lib/services/share-links';

type Ctx = { params: Promise<{ token: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { token } = await params;
  const share = getShareLinkByToken(token);
  if (!share || share.revokedAt) return NextResponse.json({ error: 'This link is no longer available.' }, { status: 410 });
  return NextResponse.json(resolveShareView(share));
}
