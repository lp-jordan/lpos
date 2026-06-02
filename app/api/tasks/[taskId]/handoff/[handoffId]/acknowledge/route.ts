/**
 * POST /api/tasks/[taskId]/handoff/[handoffId]/acknowledge
 *
 * A target assignee says "I see this, I'll get to it." Effects:
 *   • UPDATE task_handoffs SET ack_at = now, ack_user_id = session.userId,
 *     next_check_at = now + thresholdDays.
 *   • INSERT a kind='handoff_ack' comment into the updates thread so the
 *     acknowledgement is visible alongside the original handoff entry.
 *   • Notify the handing-off user via type='handoff_acknowledged'.
 *
 * Important: acknowledge does NOT complete the handoff. Only real activity
 * (status change OR comment by a target assignee) does — those hooks are in
 * Phase 5. The clock is reset rather than silenced so a still-silent ack'd
 * handoff comes back to the stale monitor on the next cycle.
 *
 * Only a user in `to_user_ids` may acknowledge. Anyone else gets 403.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore, getTaskCommentStore, getTaskHandoffStore } from '@/lib/services/container';
import { getUserById } from '@/lib/store/user-store';
import { notifyTaskEvent } from '@/lib/services/task-notification-service';
import { getSetting, SETTING_KEYS, SETTING_DEFAULTS } from '@/lib/store/lpos-settings-store';
import type { HandoffAckCommentMetadata } from '@/lib/models/task-comment';

type Params = { params: Promise<{ taskId: string; handoffId: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId, handoffId } = await params;

  const handoffStore = getTaskHandoffStore();
  const commentStore = getTaskCommentStore();
  const taskStore    = getTaskStore();

  const existing = handoffStore.getById(handoffId);
  if (!existing || existing.taskId !== taskId) {
    return NextResponse.json({ error: 'Handoff not found' }, { status: 404 });
  }
  if (existing.completedAt) {
    return NextResponse.json({ error: 'This handoff is already complete.' }, { status: 409 });
  }
  if (existing.ackAt) {
    return NextResponse.json({ error: 'This handoff has already been acknowledged.' }, { status: 409 });
  }
  if (!existing.toUserIds.includes(session.userId)) {
    return NextResponse.json({ error: 'Only the handoff target can acknowledge it.' }, { status: 403 });
  }

  const thresholdDays = getSetting<number>(
    SETTING_KEYS.HANDOFF_STALE_THRESHOLD_DAYS,
    SETTING_DEFAULTS[SETTING_KEYS.HANDOFF_STALE_THRESHOLD_DAYS],
  );

  const updated = handoffStore.acknowledge(handoffId, session.userId, thresholdDays);
  if (!updated) {
    // Race: somebody else completed/acked between our read and write.
    return NextResponse.json({ error: 'Handoff state changed — please refresh.' }, { status: 409 });
  }

  // Companion comment so the ack shows up alongside the original handoff in
  // the updates thread. Body is a short canonical phrase rather than user
  // input (the click is the message).
  const ackMeta: HandoffAckCommentMetadata = { handoffId };
  const comment = commentStore.create({
    taskId,
    body:     'Acknowledged the handoff.',
    authorId: session.userId,
    mentions: [],
    kind:     'handoff_ack',
    metadata: ackMeta as unknown as Record<string, unknown>,
  });

  // Notify the original handoff-er.
  const ackerName = getUserById(session.userId)?.name;
  if (existing.fromUserId !== session.userId) {
    const task = taskStore.getById(taskId);
    await notifyTaskEvent({
      userId:     existing.fromUserId,
      type:       'handoff_acknowledged',
      taskId,
      taskTitle:  task?.description ?? '',
      fromUserId: session.userId,
      fromName:   ackerName,
    });
  }

  return NextResponse.json({ handoff: updated, comment });
}
