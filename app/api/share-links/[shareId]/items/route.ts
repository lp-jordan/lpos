/**
 * POST   /api/share-links/:shareId/items  → add { items: [{ assetId, projectId, clientTitle? }] }
 * PATCH  /api/share-links/:shareId/items  → { assetId, projectId, clientTitle? }
 * DELETE /api/share-links/:shareId/items  → remove { assetId }
 *
 * Every share is one editable list, whether it started from a pass or not.
 * clientTitle: a string sets a manual title; null goes back to the automatic
 * one (Platform tile title, else the LPOS asset name).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { kickShareDownloads } from '@/lib/services/share-downloads';
import { addShareItems, getShareLink, removeShareItem, setShareItemTitle } from '@/lib/store/share-links-db';

type Ctx = { params: Promise<{ shareId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { shareId } = await params;
  const share = getShareLink(shareId);
  if (!share) return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  const { items } = await req.json() as { items?: Array<{ assetId: string; projectId: string; clientTitle?: string | null }> };
  if (!items?.length) return NextResponse.json({ error: 'No videos given' }, { status: 400 });
  addShareItems(shareId, items);
  kickShareDownloads();
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { shareId } = await params;
  const share = getShareLink(shareId);
  if (!share) return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  const body = await req.json() as { assetId?: string; projectId?: string; clientTitle?: string | null };
  if (!body.assetId || !body.projectId) return NextResponse.json({ error: 'assetId and projectId are required' }, { status: 400 });
  if ('clientTitle' in body) setShareItemTitle(shareId, body.assetId, body.clientTitle?.trim() || null);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { shareId } = await params;
  const { assetId } = await req.json() as { assetId?: string };
  if (!assetId) return NextResponse.json({ error: 'assetId is required' }, { status: 400 });
  removeShareItem(shareId, assetId);
  kickShareDownloads();
  return NextResponse.json({ ok: true });
}
