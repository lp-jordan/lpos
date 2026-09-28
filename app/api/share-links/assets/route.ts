/**
 * GET /api/share-links/assets?q=  → videos that can go in a share, across every
 * active project (the "+ Add videos" picker). Each carries its Platform tile
 * title when it has one, since that's what the share will display.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { listShareableAssets } from '@/lib/services/share-links';

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const q = new URL(req.url).searchParams.get('q') ?? '';
  return NextResponse.json({ assets: listShareableAssets(q) });
}
