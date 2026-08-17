import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskCommentStore } from '@/lib/services/container';
import { REACTION_VALUES } from '@/lib/models/reaction';

type Params = { params: Promise<{ taskId: string; commentId: string }> };

/** Toggle the caller's reaction on one task comment. Unlike PATCH/DELETE on the
 *  parent route this is open to any signed-in user — reacting to someone else's
 *  comment is the whole point. Any kind is accepted here, but the UI only
 *  surfaces the control on plain comments — handoff/ack callouts stay clean. */
export async function POST(req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId, commentId } = await params;
  const store   = getTaskCommentStore();
  const comment = store.getById(commentId);
  if (!comment || comment.taskId !== taskId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const payload = await req.json() as { emoji?: unknown };
  if (typeof payload.emoji !== 'string' || !REACTION_VALUES.includes(payload.emoji)) {
    return NextResponse.json({ error: 'Unsupported reaction' }, { status: 400 });
  }

  const reactions = store.toggleReaction(commentId, session.userId, payload.emoji);
  return NextResponse.json({ reactions });
}
