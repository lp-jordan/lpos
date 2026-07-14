/**
 * Task review-checkin store — machine-readable state for the ReviewStaleMonitor.
 *
 * Mirrors TaskHandoffStore's shape (thin, monitor-focused, ISO timestamps that
 * compare lexicographically so we can index + WHERE on next_check_at directly).
 * The key behavioural difference from handoffs lives in the API/monitor layer,
 * not here: activity RESETS the clock rather than completing the check-in.
 */

import { randomUUID } from 'node:crypto';
import type {
  TaskReviewCheckin,
  ReviewCheckinCompletedReason,
} from '@/lib/models/task-review-checkin';
import { getCoreDb } from './core-db';
import { addDaysIso } from './task-handoff-store';

interface CheckinRow {
  checkin_id:        string;
  task_id:           string;
  opened_at:         string;
  last_ack_at:       string | null;
  last_ack_user_id:  string | null;
  completed_at:      string | null;
  completed_reason:  string | null;
  next_check_at:     string | null;
  last_alert_at:     string | null;
  alert_count:       number;
}

function rowToCheckin(row: CheckinRow): TaskReviewCheckin {
  return {
    checkinId:        row.checkin_id,
    taskId:           row.task_id,
    openedAt:         row.opened_at,
    lastAckAt:        row.last_ack_at,
    lastAckUserId:    row.last_ack_user_id,
    completedAt:      row.completed_at,
    completedReason:  (row.completed_reason as ReviewCheckinCompletedReason | null) ?? null,
    nextCheckAt:      row.next_check_at,
    lastAlertAt:      row.last_alert_at,
    alertCount:       row.alert_count,
  };
}

export class TaskReviewCheckinStore {
  // ── Read ────────────────────────────────────────────────────────────────

  getById(checkinId: string): TaskReviewCheckin | null {
    const row = getCoreDb()
      .prepare('SELECT * FROM task_review_checkins WHERE checkin_id = ?')
      .get(checkinId) as CheckinRow | undefined;
    return row ? rowToCheckin(row) : null;
  }

  /** The single pending check-in for this task, if any. There is at most one —
   *  create() is guarded on there being none open, and the completion hooks
   *  close it when the task leaves Review or is reassigned. */
  getPendingForTask(taskId: string): TaskReviewCheckin | null {
    const row = getCoreDb()
      .prepare(
        `SELECT * FROM task_review_checkins
         WHERE task_id = ? AND completed_at IS NULL
         ORDER BY opened_at DESC LIMIT 1`,
      )
      .get(taskId) as CheckinRow | undefined;
    return row ? rowToCheckin(row) : null;
  }

  /** Pending check-ins due at or before `now`. The partial index on
   *  `(next_check_at) WHERE completed_at IS NULL` keeps this cheap. */
  listDue(nowIso: string): TaskReviewCheckin[] {
    const rows = getCoreDb()
      .prepare(
        `SELECT * FROM task_review_checkins
         WHERE completed_at IS NULL AND next_check_at IS NOT NULL AND next_check_at <= ?
         ORDER BY next_check_at ASC`,
      )
      .all(nowIso) as CheckinRow[];
    return rows.map(rowToCheckin);
  }

  /** Task IDs that currently have a pending check-in — used by the monitor's
   *  backfill pass to avoid opening a duplicate for a task already watched. */
  pendingTaskIds(): Set<string> {
    const rows = getCoreDb()
      .prepare('SELECT task_id FROM task_review_checkins WHERE completed_at IS NULL')
      .all() as Array<{ task_id: string }>;
    return new Set(rows.map((r) => r.task_id));
  }

  // ── Write ───────────────────────────────────────────────────────────────

  /** Open a check-in for a task that just entered Review. No-ops (returns the
   *  existing row) if one is already pending, so callers don't need to guard. */
  create(taskId: string, thresholdDays: number): TaskReviewCheckin {
    const existing = this.getPendingForTask(taskId);
    if (existing) return existing;

    const openedAt    = new Date().toISOString();
    const nextCheckAt = addDaysIso(openedAt, thresholdDays);
    const checkinId   = randomUUID();
    getCoreDb()
      .prepare(
        `INSERT INTO task_review_checkins (
           checkin_id, task_id, opened_at, next_check_at, alert_count
         ) VALUES (?, ?, ?, ?, 0)`,
      )
      .run(checkinId, taskId, openedAt, nextCheckAt);
    return this.getById(checkinId)!;
  }

  /** Re-arm the clock without recording an explicit ack — used when an assignee
   *  posts a comment or the task is reassigned in place (still in Review). */
  resetForTask(taskId: string, thresholdDays: number): TaskReviewCheckin | null {
    const pending = this.getPendingForTask(taskId);
    if (!pending) return null;
    const next = addDaysIso(new Date().toISOString(), thresholdDays);
    getCoreDb()
      .prepare(
        `UPDATE task_review_checkins SET next_check_at = ?
          WHERE checkin_id = ? AND completed_at IS NULL`,
      )
      .run(next, pending.checkinId);
    return this.getById(pending.checkinId);
  }

  /** Explicit "I'm still on it" acknowledgement. Records who/when and re-arms
   *  the clock. Does NOT complete the check-in. */
  acknowledge(checkinId: string, userId: string, thresholdDays: number): TaskReviewCheckin | null {
    const now  = new Date().toISOString();
    const next = addDaysIso(now, thresholdDays);
    const result = getCoreDb()
      .prepare(
        `UPDATE task_review_checkins
            SET last_ack_at = ?, last_ack_user_id = ?, next_check_at = ?
          WHERE checkin_id = ? AND completed_at IS NULL`,
      )
      .run(now, userId, next, checkinId) as { changes: number };
    if (result.changes === 0) return null;
    return this.getById(checkinId);
  }

  /** Record that the stale monitor fired. Re-arms the clock. */
  markAlerted(checkinId: string, thresholdDays: number): TaskReviewCheckin | null {
    const now  = new Date().toISOString();
    const next = addDaysIso(now, thresholdDays);
    const result = getCoreDb()
      .prepare(
        `UPDATE task_review_checkins
            SET last_alert_at = ?, alert_count = alert_count + 1, next_check_at = ?
          WHERE checkin_id = ? AND completed_at IS NULL`,
      )
      .run(now, next, checkinId) as { changes: number };
    if (result.changes === 0) return null;
    return this.getById(checkinId);
  }

  /** Close out a check-in and clear next_check_at so the sweep stops seeing it. */
  markCompleted(checkinId: string, reason: ReviewCheckinCompletedReason): TaskReviewCheckin | null {
    const now = new Date().toISOString();
    const result = getCoreDb()
      .prepare(
        `UPDATE task_review_checkins
            SET completed_at = ?, completed_reason = ?, next_check_at = NULL
          WHERE checkin_id = ? AND completed_at IS NULL`,
      )
      .run(now, reason, checkinId) as { changes: number };
    if (result.changes === 0) return null;
    return this.getById(checkinId);
  }

  /** Complete this task's pending check-in (if any) — used when the task leaves
   *  Review or is reassigned. Returns the closed row, or null if none pending. */
  completeForTask(taskId: string, reason: ReviewCheckinCompletedReason): TaskReviewCheckin | null {
    const pending = this.getPendingForTask(taskId);
    if (!pending) return null;
    return this.markCompleted(pending.checkinId, reason);
  }
}
