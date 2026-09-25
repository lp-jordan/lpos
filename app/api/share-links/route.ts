/**
 * GET  /api/share-links?projectId=&passId=  → share summaries (optionally filtered)
 * POST /api/share-links                     → create { name, passId?, preset?, caps?, audience?, emails?, items? }
 *
 * The unified Share system (see lib/store/share-links-db.ts). Distinct from
 * /api/shares, which lists legacy Frame.io share links.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireRole } from '@/lib/services/api-auth';
import { createShareLink, getShareLinkForPass, type CreateShareInput } from '@/lib/store/share-links-db';
import { getPass } from '@/lib/store/platform-pass-store';
import { listShareSummaries } from '@/lib/services/share-links';

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const sp = new URL(req.url).searchParams;
  return NextResponse.json({
    shares: listShareSummaries({ projectId: sp.get('projectId') ?? undefined, passId: sp.get('passId') ?? undefined }),
  });
}

export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const session = await getSession(req);
  const body = await req.json() as CreateShareInput;

  if (body.passId) {
    const pass = getPass(body.passId);
    if (!pass) return NextResponse.json({ error: 'Pass not found' }, { status: 404 });
    // One share per pass — sharing an already-shared pass returns the existing link.
    const existing = getShareLinkForPass(body.passId);
    if (existing) return NextResponse.json({ share: existing });
    body.name = body.name?.trim() || pass.title;
  } else if (!body.items?.length) {
    return NextResponse.json({ error: 'Pick at least one video to share.' }, { status: 400 });
  }

  const share = createShareLink({ ...body, name: body.name ?? 'Untitled share', createdBy: session?.userId ?? null });
  return NextResponse.json({ share }, { status: 201 });
}
