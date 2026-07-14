/**
 * ReviewStaleMonitor — nudges assignees of Editing tasks that have sat in the
 * 'in_review' status past the configured threshold (default 3 days).
 *
 * Sibling of HandoffStaleMonitor; same partial-indexed sweep, same admin-tunable
 * threshold + cadence via lpos_settings. Two behavioural differences:
 *
 *   1. Backfill — each tick first opens a check-in for any Editing task that is
 *      currently in Review but has none pending. This covers tasks that were
 *      already stuck when the feature shipped (they start their clock now) and
 *      is a safety net if a status-change hook was ever missed.
 *
 *   2. The alarm is silenced by *leaving Review or being reassigned*, not by
 *      activity — a comment / Acknowledge only resets the clock (handled in the
 *      API layer). So a task that keeps sitting comes back here every threshold.
 *
 * The re-ping targets the task's current assignees (falling back to the creator
 * if somehow unassigned) — Review is a whole-task state, not a per-user handoff.
 */

import type { Monitor } from '@/lib/services/monitor-registry';
import { getTaskStore, getTaskReviewCheckinStore } from '@/lib/services/container';
import { notifyTaskEvent } from '@/lib/services/task-notification-service';
import { getSetting, SETTING_KEYS, SETTING_DEFAULTS } from '@/lib/store/lpos-settings-store';
import { REVIEW_STATUS } from '@/lib/models/task-review-checkin';

/** A task is watched only on the edit dashboard: Editing type, in_review status. */
function isEditingReview(taskType: string, status: string): boolean {
  return taskType === 'editing' && status === REVIEW_STATUS;
}

export class ReviewStaleMonitor implements Monitor {
  readonly name = 'review-stale';
  readonly description =
    'Re-pings assignees of Editing tasks that have sat in Review past the inactivity threshold.';
  readonly tickIntervalMs: number;

  constructor() {
    const minutes = getSetting<number>(
      SETTING_KEYS.REVIEW_MONITOR_TICK_MINUTES,
      SETTING_DEFAULTS[SETTING_KEYS.REVIEW_MONITOR_TICK_MINUTES],
    );
    const clamped = Math.max(1, Math.min(24 * 60, Math.round(minutes)));
    this.tickIntervalMs = clamped * 60_000;
  }

  async tick(): Promise<void> {
    const taskStore    = getTaskStore();
    const checkinStore = getTaskReviewCheckinStore();

    // Re-read threshold every tick so admin changes apply next cycle, no restart.
    const thresholdDays = getSetting<number>(
      SETTING_KEYS.REVIEW_STALE_THRESHOLD_DAYS,
      SETTING_DEFAULTS[SETTING_KEYS.REVIEW_STALE_THRESHOLD_DAYS],
    );

    // ── Backfill: open a check-in for any Editing task currently in Review
    //    that isn't already watched. Cheap — the tasks table is small. ────────
    const pendingIds = checkinStore.pendingTaskIds();
    for (const task of taskStore.getAll()) {
      if (!isEditingReview(task.taskType, task.status)) continue;
      if (pendingIds.has(task.taskId)) continue;
      checkinStore.create(task.taskId, thresholdDays);
    }

    // ── Sweep due check-ins ──────────────────────────────────────────────────
    const now = new Date().toISOString();
    const due = checkinStore.listDue(now);
    if (due.length === 0) return;

    console.log(`[review-stale-monitor] ${due.length} review check-in(s) due for re-ping`);

    for (const checkin of due) {
      const task = taskStore.getById(checkin.taskId);
      if (!task) {
        checkinStore.markCompleted(checkin.checkinId, 'task_deleted');
        console.warn(`[review-stale-monitor] check-in ${checkin.checkinId} references missing task — closing`);
        continue;
      }

      // If the task left Review (moved to another status / Done) since the last
      // sweep and the PATCH hook somehow didn't close the check-in, close it now.
      if (!isEditingReview(task.taskType, task.status)) {
        checkinStore.markCompleted(checkin.checkinId, 'status_change');
        console.log(`[review-stale-monitor] check-in ${checkin.checkinId} skipped — task no longer in Review (status '${task.status}')`);
        continue;
      }

      // Whole-task nudge to the current assignees; fall back to the creator so a
      // stuck-but-unassigned task isn't silently ignored.
      const recipients = task.assignedTo.length > 0 ? task.assignedTo : [task.createdBy];
      await Promise.allSettled(
        recipients.map((uid) =>
          notifyTaskEvent({
            userId:    uid,
            type:      'review_stale',
            taskId:    checkin.taskId,
            taskTitle: task.description,
          }),
        ),
      );

      checkinStore.markAlerted(checkin.checkinId, thresholdDays);
    }
  }
}
