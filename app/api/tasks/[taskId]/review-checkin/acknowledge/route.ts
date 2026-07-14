/**
 * POST /api/tasks/[taskId]/review-checkin/acknowledge
 *
 * An assignee (or anyone with the task open) says "still on it" without posting
 * a substantive update. Effects:
 *   • Resets the check-in clock to now + thresholdDays (does NOT complete it —
 *     the task stays in Review, so it keeps being watched).
 *   • Writes a kind='review_ack' comment so the acknowledgement shows in the
 *     updates thread (companion artifact, mirrors handoff_ack).
 *
 * Idempotent-ish: if there's no pending check-in (task left Review, or the
 * feature just hasn't opened one yet) we return 409 so the client can refresh.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore, getTaskCommentStore, getTaskReviewCheckinStore } from '@/lib/services/container';
import { getSetting, SETTING_KEYS, SETTING_DEFAULTS } from '@/lib/store/lpos-settings-store';

type Params = { params: Promise<{ taskId: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId } = await params;

  const reviewStore  = getTaskReviewCheckinStore();
  const commentStore = getTaskCommentStore();
  const taskStore    = getTaskStore();

  const task = taskStore.getById(taskId);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const pending = reviewStore.getPendingForTask(taskId);
  if (!pending) {
    return NextResponse.json({ error: 'No active Review check-in for this task.' }, { status: 409 });
  }

  const thresholdDays = getSetting<number>(
    SETTING_KEYS.REVIEW_STALE_THRESHOLD_DAYS,
    SETTING_DEFAULTS[SETTING_KEYS.REVIEW_STALE_THRESHOLD_DAYS],
  );

  const updated = reviewStore.acknowledge(pending.checkinId, session.userId, thresholdDays);
  if (!updated) {
    // Race: completed between our read and write.
    return NextResponse.json({ error: 'Check-in state changed — please refresh.' }, { status: 409 });
  }

  // Companion comment so the ack is visible in the updates thread. Body is a
  // canonical phrase — the click is the message.
  const comment = commentStore.create({
    taskId,
    body:     'Acknowledged — still in review.',
    authorId: session.userId,
    mentions: [],
    kind:     'review_ack',
    metadata: { checkinId: pending.checkinId },
  });

  return NextResponse.json({ checkin: updated, comment });
}
