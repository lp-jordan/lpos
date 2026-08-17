import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess, getSession } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { REACTION_VALUES } from '@/lib/models/reaction';

type Ctx = { params: Promise<{ prospectId: string; updateId: string }> };

/** Toggle the caller's reaction on one update. Unlike edit/delete this is open
 *  to anyone with prospects access — reacting to your own update is fine, and
 *  the point of the feature is reacting to other people's. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const session = await getSession(req);
  const { prospectId, updateId } = await params;
  const store = getProspectStore();

  const existing = store.getUpdate(updateId);
  if (!existing || existing.prospectId !== prospectId) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const body = await req.json() as { emoji?: unknown };
  if (typeof body.emoji !== 'string' || !REACTION_VALUES.includes(body.emoji)) {
    return NextResponse.json({ error: 'Unsupported reaction.' }, { status: 400 });
  }

  const reactions = store.toggleUpdateReaction(updateId, session!.userId, body.emoji);
  return NextResponse.json({ reactions });
}
