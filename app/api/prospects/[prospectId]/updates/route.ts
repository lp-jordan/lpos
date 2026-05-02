import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess, getSession } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { notifyProspectEvent } from '@/lib/services/prospect-notification-service';
import { getUserById } from '@/lib/store/user-store';

type Ctx = { params: Promise<{ prospectId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { prospectId } = await params;
  const updates = getProspectStore().getUpdates(prospectId);
  return NextResponse.json({ updates });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const session = await getSession(req);
  const { prospectId } = await params;
  const store = getProspectStore();

  if (!store.getById(prospectId)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const body = await req.json() as { body?: unknown };
  if (!body.body || typeof body.body !== 'string' || !body.body.trim()) {
    return NextResponse.json({ error: 'Update body is required.' }, { status: 400 });
  }

  const prospect = store.getById(prospectId)!;
  const update   = store.addUpdate(prospectId, session!.userId, body.body.trim());

  const actor = getUserById(session!.userId);

  // Extract @[Name](userId) mentions from body
  const mentionedIds = new Set<string>();
  const mentionRegex = /@\[[^\]]+\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mentionRegex.exec(body.body.trim())) !== null) mentionedIds.add(m[1]);

  // Notify all assigned users except the author (update_posted)
  const assignedTargets = prospect.assignedTo.filter((id) => id !== session!.userId);
  void Promise.allSettled(
    assignedTargets.map((userId) =>
      notifyProspectEvent({
        userId,
        type:       'update_posted',
        prospectId,
        company:    prospect.company,
        fromUserId: session!.userId,
        fromName:   actor?.name,
      }),
    ),
  );

  // Notify mentioned users who are not already getting update_posted
  const assignedSet = new Set(prospect.assignedTo);
  const mentionTargets = Array.from(mentionedIds).filter(
    (id) => id !== session!.userId && !assignedSet.has(id),
  );
  void Promise.allSettled(
    mentionTargets.map((userId) =>
      notifyProspectEvent({
        userId,
        type:       'mentioned',
        prospectId,
        company:    prospect.company,
        fromUserId: session!.userId,
        fromName:   actor?.name,
      }),
    ),
  );

  return NextResponse.json({ update }, { status: 201 });
}
