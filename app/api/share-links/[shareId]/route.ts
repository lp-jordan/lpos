/**
 * GET    /api/share-links/:shareId  → { share, view }
 * PATCH  /api/share-links/:shareId  → { name?, caps?, audience?, emails? }
 * DELETE /api/share-links/:shareId  → revoke (the link stops working; nothing is deleted)
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getShareLink, revokeShareLink, updateShareLink, type ShareLinkPatch } from '@/lib/store/share-links-db';
import { resolveShareView } from '@/lib/services/share-links';

type Ctx = { params: Promise<{ shareId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { shareId } = await params;
  const share = getShareLink(shareId);
  if (!share) return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  return NextResponse.json({ share, view: resolveShareView(share) });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { shareId } = await params;
  const patch = await req.json() as ShareLinkPatch;
  const share = updateShareLink(shareId, patch);
  if (!share) return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  return NextResponse.json({ share });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { shareId } = await params;
  if (!getShareLink(shareId)) return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  revokeShareLink(shareId);
  return new NextResponse(null, { status: 204 });
}
