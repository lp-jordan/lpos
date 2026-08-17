import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskCommentStore, getTaskNotificationStore, getTaskStore } from '@/lib/services/container';
import { notifyTaskEvent } from '@/lib/services/task-notification-service';
import { getUserById } from '@/lib/store/user-store';
import { REACTION_VALUES, REACTION_NOTIFY_WINDOW_MIN } from '@/lib/models/reaction';

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

  // Notify the comment's author — but only when the reaction was ADDED (removing
  // one is not an event anyone needs to hear about), never to yourself, and at
  // most once per actor per task per REACTION_NOTIFY_WINDOW_MIN. The window is
  // what makes un-react/re-react toggling and rapid multi-emoji reacting
  // collapse into a single ping instead of a burst.
  const added = reactions.some((r) => r.emoji === payload.emoji && r.userIds.includes(session.userId));
  if (added && comment.authorId !== session.userId) {
    const since = new Date(Date.now() - REACTION_NOTIFY_WINDOW_MIN * 60_000).toISOString();
    if (!getTaskNotificationStore().hasRecentReaction(comment.authorId, taskId, session.userId, since)) {
      const task  = getTaskStore().getById(taskId);
      const actor = getUserById(session.userId);
      void notifyTaskEvent({
        userId:    comment.authorId,
        type:      'reacted',
        taskId,
        taskTitle: task?.description ?? '',
        fromUserId: session.userId,
        fromName:  actor?.name,
        emoji:     payload.emoji,
      });
    }
  }

  return NextResponse.json({ reactions });
}
