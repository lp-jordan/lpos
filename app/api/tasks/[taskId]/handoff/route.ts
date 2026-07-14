/**
 * POST /api/tasks/[taskId]/handoff
 *
 * Atomically:
 *   1. Reads the task's current assignees (= prior_assignees on the new
 *      handoff record).
 *   2. If there's a pending handoff for this task, closes it with
 *      completed_reason='next_handoff' so the chain advances cleanly and the
 *      monitor stops watching the old row.
 *   3. Replaces the task's assignees with toUserIds (whole-task semantics —
 *      the handing-off user is dropped along with everyone else, see
 *      design discussion).
 *   4. Writes a kind='handoff' row to task_comments (the human-readable
 *      artifact in the updates thread).
 *   5. Writes the matching task_handoffs row (machine-readable monitor state).
 *   6. Notifies each target assignee via the existing TaskNotificationService.
 *
 * The threshold (days until first stale re-ping) is read from lpos_settings
 * so admins can tune it without a redeploy.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore, getTaskCommentStore, getTaskHandoffStore, getTaskReviewCheckinStore } from '@/lib/services/container';
import { getUserById, getAllUsers } from '@/lib/store/user-store';
import { notifyTaskEvent } from '@/lib/services/task-notification-service';
import { emitTaskUpdated } from '@/lib/services/task-broadcasts';
import { getSetting, SETTING_KEYS, SETTING_DEFAULTS } from '@/lib/store/lpos-settings-store';
import type { HandoffCommentMetadata } from '@/lib/models/task-comment';

type Params = { params: Promise<{ taskId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId } = await params;

  const body = await req.json() as { toUserIds?: unknown; note?: unknown };

  // ── Validate ────────────────────────────────────────────────────────────
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) {
    return NextResponse.json({ error: 'A handoff note is required.' }, { status: 400 });
  }

  if (!Array.isArray(body.toUserIds) || body.toUserIds.length === 0) {
    return NextResponse.json({ error: 'At least one new assignee is required.' }, { status: 400 });
  }
  const toUserIds = (body.toUserIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (toUserIds.length === 0) {
    return NextResponse.json({ error: 'At least one new assignee is required.' }, { status: 400 });
  }

  // Sanity: validate every target maps to a real user
  const allUsers = getAllUsers();
  const userIds = new Set(allUsers.map((u) => u.id));
  for (const uid of toUserIds) {
    if (!userIds.has(uid)) {
      return NextResponse.json({ error: `Unknown user: ${uid}` }, { status: 400 });
    }
  }

  // ── Read task + prior assignees ─────────────────────────────────────────
  const taskStore    = getTaskStore();
  const commentStore = getTaskCommentStore();
  const handoffStore = getTaskHandoffStore();

  const task = taskStore.getById(taskId);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const priorAssignees = [...task.assignedTo];

  // ── Chain handling: close any existing pending handoff ──────────────────
  // The chain is "Bob (target of prior handoff) hands off again" — the prior
  // handoff is considered acted-on (action being the new handoff itself), so
  // we close it with completed_reason='next_handoff' so the stale monitor
  // stops watching it. The new handoff gets its own fresh clock below.
  const existingPending = handoffStore.getPendingForTask(taskId);
  if (existingPending) {
    handoffStore.markCompleted(existingPending.handoffId, 'next_handoff');
  }

  // Reassignment supersedes a Review check-in: the new handoff starts its own
  // 3-day stale re-ping on the new assignee, so stand the Review check-in down
  // to avoid double-nudging the same task. (User decision: handoff takes over.)
  getTaskReviewCheckinStore().completeForTask(taskId, 'handoff');

  // ── Replace assignees on the task ───────────────────────────────────────
  const updatedTask = taskStore.update(taskId, { assignedTo: toUserIds });
  if (!updatedTask) {
    // Race: the task was deleted between getById and update. 404 cleanly.
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  // ── Threshold (admin-tunable) ───────────────────────────────────────────
  const thresholdDays = getSetting<number>(
    SETTING_KEYS.HANDOFF_STALE_THRESHOLD_DAYS,
    SETTING_DEFAULTS[SETTING_KEYS.HANDOFF_STALE_THRESHOLD_DAYS],
  );

  // ── Insert handoff row first so the comment's metadata can reference its ID ─
  const handoff = handoffStore.create({
    taskId,
    fromUserId:     session.userId,
    toUserIds,
    priorAssignees,
    note,
    thresholdDays,
  });

  const metadata: HandoffCommentMetadata = {
    handoffId:        handoff.handoffId,
    fromUserId:       handoff.fromUserId,
    toUserIds:        handoff.toUserIds,
    priorAssigneeIds: handoff.priorAssignees,
  };
  const comment = commentStore.create({
    taskId,
    body:     note,
    authorId: session.userId,
    mentions: [],
    kind:     'handoff',
    metadata: metadata as unknown as Record<string, unknown>,
  });

  // ── Broadcast + notify ──────────────────────────────────────────────────
  emitTaskUpdated(updatedTask);

  const actorName = getUserById(session.userId)?.name;
  await Promise.allSettled(
    toUserIds
      .filter((uid) => uid !== session.userId) // don't notify yourself if you hand it off to yourself + others
      .map((uid) =>
        notifyTaskEvent({
          userId:     uid,
          type:       'handoff',
          taskId,
          taskTitle:  updatedTask.description,
          fromUserId: session.userId,
          fromName:   actorName,
        }),
      ),
  );

  return NextResponse.json({ handoff, comment, task: updatedTask }, { status: 201 });
}
