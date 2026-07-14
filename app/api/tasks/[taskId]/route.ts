import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore, getTaskHandoffStore, getTaskReviewCheckinStore } from '@/lib/services/container';
import type { TaskPriority } from '@/lib/models/task';
import type { TaskType } from '@/lib/models/task-phase';
import { isTerminalStatus } from '@/lib/models/task-phase';
import { REVIEW_STATUS } from '@/lib/models/task-review-checkin';
import { getSetting, SETTING_KEYS, SETTING_DEFAULTS } from '@/lib/store/lpos-settings-store';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import { getUserById } from '@/lib/store/user-store';
import { notifyTaskEvent } from '@/lib/services/task-notification-service';
import { emitTaskDeleted, emitTaskUpdated } from '@/lib/services/task-broadcasts';

/** Days a task may sit in Review before a re-ping — admin-tunable, no redeploy. */
function reviewThresholdDays(): number {
  return getSetting<number>(
    SETTING_KEYS.REVIEW_STALE_THRESHOLD_DAYS,
    SETTING_DEFAULTS[SETTING_KEYS.REVIEW_STALE_THRESHOLD_DAYS],
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId } = await params;
  const body = await req.json() as {
    status?: string;
    description?: string;
    assignedTo?: string[];
    priority?: TaskPriority;
    taskType?: TaskType;
    clientName?: string;
    category?: string | null;
  };

  const prev = getTaskStore().getById(taskId);
  const updated = getTaskStore().update(taskId, body);
  if (!updated) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  emitTaskUpdated(updated);

  const actor = getUserById(session.userId);
  const actorName = actor?.name ?? undefined;
  const now = new Date().toISOString();

  const statusChanged = body.status !== undefined && prev !== null && body.status !== prev.status;
  const assigneesChanged = body.assignedTo !== undefined;

  recordActivity({
    actor_type: 'user',
    actor_id: session.userId,
    actor_display: actorName ?? null,
    occurred_at: now,
    event_type: statusChanged ? 'task.status.changed' : 'task.updated',
    lifecycle_phase: 'updated',
    source_kind: 'api',
    visibility: 'user_timeline',
    title: statusChanged
      ? `Task marked ${body.status?.replace(/_/g, ' ')}: ${updated.description}`
      : `Task updated: ${updated.description}`,
    project_id: null,
    client_id: updated.clientName !== 'General' ? updated.clientName : null,
  });

  const notified = new Set<string>([session.userId]);

  // Notify on status change
  if (statusChanged) {
    await Promise.allSettled(
      updated.assignedTo
        .filter((uid) => !notified.has(uid))
        .map((uid) => {
          notified.add(uid);
          return notifyTaskEvent({ userId: uid, type: 'status_changed', taskId, taskTitle: updated.description, fromUserId: session.userId, fromName: actorName });
        }),
    );

    // Activity-completes-handoff: a status change by a current target assignee
    // counts as the new owner engaging, which silences any pending handoff
    // alarm on this task. The store helper no-ops when the actor isn't a
    // target, so no need to gate the call.
    const handoffStore = getTaskHandoffStore();
    if (isTerminalStatus(updated.taskType, updated.status)) {
      // Moving a task to its terminal ("Done") status closes the work outright,
      // so silence any pending handoff regardless of who marked it done — a
      // finished task should never be re-pinged. (completeOnActivity only fires
      // for a target assignee, which wouldn't cover an admin/handoff-er closing
      // it out.)
      const pending = handoffStore.getPendingForTask(taskId);
      if (pending) handoffStore.markCompleted(pending.handoffId, 'status_change');
    } else {
      handoffStore.completeOnActivity(taskId, session.userId, 'status_change');
    }

    // Review check-in lifecycle: open one when an Editing task enters Review,
    // close it when it leaves. Only the edit dashboard (taskType 'editing') is
    // watched. `prev` is non-null here (statusChanged requires it).
    const reviewStore   = getTaskReviewCheckinStore();
    const wasInReview   = prev!.taskType === 'editing' && prev!.status === REVIEW_STATUS;
    const nowInReview   = updated.taskType === 'editing' && updated.status === REVIEW_STATUS;
    if (nowInReview && !wasInReview) {
      reviewStore.create(taskId, reviewThresholdDays());
    } else if (wasInReview && !nowInReview) {
      reviewStore.completeForTask(taskId, 'status_change');
    }
  }

  // In-place reassignment (assignee checkboxes, not a handoff) while a task is
  // still in Review: give the new assignee a fresh window rather than firing
  // immediately. A handoff, by contrast, hands watching over to the handoff
  // monitor — see app/api/tasks/[taskId]/handoff/route.ts.
  if (assigneesChanged && updated.taskType === 'editing' && updated.status === REVIEW_STATUS) {
    getTaskReviewCheckinStore().resetForTask(taskId, reviewThresholdDays());
  }

  // Notify newly added assignees
  if (assigneesChanged && prev) {
    const prevIds = new Set(prev.assignedTo);
    await Promise.allSettled(
      (body.assignedTo ?? [])
        .filter((uid) => !prevIds.has(uid) && !notified.has(uid))
        .map((uid) => {
          notified.add(uid);
          return notifyTaskEvent({ userId: uid, type: 'assigned', taskId, taskTitle: updated.description, fromUserId: session.userId, fromName: actorName });
        }),
    );
  }

  return NextResponse.json({ task: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId } = await params;
  const ok = getTaskStore().delete(taskId);
  if (!ok) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  emitTaskDeleted(taskId);

  return NextResponse.json({ ok: true });
}
