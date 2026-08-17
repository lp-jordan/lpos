import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess, getSession } from '@/lib/services/api-auth';
import { getProspectStore, getProspectNotificationStore } from '@/lib/services/container';
import { notifyProspectEvent } from '@/lib/services/prospect-notification-service';
import { getUserById } from '@/lib/store/user-store';
import { REACTION_VALUES, REACTION_NOTIFY_WINDOW_MIN } from '@/lib/models/reaction';

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

  // Notify the update's author — but only when the reaction was ADDED (removing
  // one is not an event anyone needs to hear about), never to yourself, and at
  // most once per actor per prospect per REACTION_NOTIFY_WINDOW_MIN. The window
  // is what makes un-react/re-react toggling and rapid multi-emoji reacting
  // collapse into a single ping instead of a burst.
  const added = reactions.some((r) => r.emoji === body.emoji && r.userIds.includes(session!.userId));
  if (added && existing.authorId !== session!.userId) {
    const since = new Date(Date.now() - REACTION_NOTIFY_WINDOW_MIN * 60_000).toISOString();
    const notifStore = getProspectNotificationStore();
    if (!notifStore.hasRecentReaction(existing.authorId, prospectId, session!.userId, since)) {
      const prospect = getProspectStore().getById(prospectId);
      const actor    = getUserById(session!.userId);
      void notifyProspectEvent({
        userId:     existing.authorId,
        type:       'reacted',
        prospectId,
        company:    prospect?.company ?? '',
        fromUserId: session!.userId,
        fromName:   actor?.name,
        emoji:      body.emoji,
      });
    }
  }

  return NextResponse.json({ reactions });
}
