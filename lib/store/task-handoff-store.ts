/**
 * Task handoff store — machine-readable state for the chain-of-custody flow.
 *
 * Keeps the schema thin and focused on what the HandoffStaleMonitor and the
 * activity-completes-handoff hooks need to read. The human-readable artifact
 * is the companion `task_comments` row with kind='handoff' / kind='handoff_ack'.
 *
 * All time-related operations use ISO 8601 strings — SQLite compares them
 * lexicographically and that ordering matches chronological order for ISO
 * timestamps, so we can index + WHERE on them directly.
 */

import { randomUUID } from 'node:crypto';
import type { TaskHandoff, HandoffCompletedReason } from '@/lib/models/task-handoff';
import { getCoreDb } from './core-db';

interface HandoffRow {
  handoff_id:        string;
  task_id:           string;
  from_user_id:      string;
  to_user_ids:       string;     // JSON array
  prior_assignees:   string;     // JSON array
  note:              string;
  created_at:        string;
  ack_at:            string | null;
  ack_user_id:       string | null;
  completed_at:      string | null;
  completed_reason:  string | null;
  next_check_at:     string | null;
  last_alert_at:     string | null;
  alert_count:       number;
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToHandoff(row: HandoffRow): TaskHandoff {
  return {
    handoffId:        row.handoff_id,
    taskId:           row.task_id,
    fromUserId:       row.from_user_id,
    toUserIds:        parseJsonArray(row.to_user_ids),
    priorAssignees:   parseJsonArray(row.prior_assignees),
    note:             row.note,
    createdAt:        row.created_at,
    ackAt:            row.ack_at,
    ackUserId:        row.ack_user_id,
    completedAt:      row.completed_at,
    completedReason:  (row.completed_reason as HandoffCompletedReason | null) ?? null,
    nextCheckAt:      row.next_check_at,
    lastAlertAt:      row.last_alert_at,
    alertCount:       row.alert_count,
  };
}

/** Add `days` days to an ISO timestamp, returning a fresh ISO string. */
export function addDaysIso(from: string, days: number): string {
  const t = new Date(from).getTime();
  return new Date(t + days * 86_400_000).toISOString();
}

export class TaskHandoffStore {
  // ── Read ────────────────────────────────────────────────────────────────

  getById(handoffId: string): TaskHandoff | null {
    const row = getCoreDb()
      .prepare('SELECT * FROM task_handoffs WHERE handoff_id = ?')
      .get(handoffId) as HandoffRow | undefined;
    return row ? rowToHandoff(row) : null;
  }

  /** Most recent first — useful for the chain display + activity hooks (which
   *  only care about the latest pending handoff). */
  getForTask(taskId: string): TaskHandoff[] {
    const rows = getCoreDb()
      .prepare('SELECT * FROM task_handoffs WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as HandoffRow[];
    return rows.map(rowToHandoff);
  }

  /** Returns the single pending handoff for this task (if any). There should
   *  be at most one — the activity hooks complete the previous one before a
   *  new handoff is recorded, and the chain-handoff path explicitly closes
   *  the prior row with completed_reason='next_handoff'. */
  getPendingForTask(taskId: string): TaskHandoff | null {
    const row = getCoreDb()
      .prepare(
        `SELECT * FROM task_handoffs
         WHERE task_id = ? AND completed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as HandoffRow | undefined;
    return row ? rowToHandoff(row) : null;
  }

  /** Pending handoffs whose next_check_at is at or before `now`. The partial
   *  index on `(next_check_at) WHERE completed_at IS NULL` keeps this cheap
   *  even as the table grows. */
  listDue(nowIso: string): TaskHandoff[] {
    const rows = getCoreDb()
      .prepare(
        `SELECT * FROM task_handoffs
         WHERE completed_at IS NULL AND next_check_at IS NOT NULL AND next_check_at <= ?
         ORDER BY next_check_at ASC`,
      )
      .all(nowIso) as HandoffRow[];
    return rows.map(rowToHandoff);
  }

  // ── Write ───────────────────────────────────────────────────────────────

  create(input: {
    taskId:          string;
    fromUserId:      string;
    toUserIds:       string[];
    priorAssignees:  string[];
    note:            string;
    /** Days of inactivity before the first re-ping. Caller pulls this from
     *  lpos_settings so the admin can tune it without code changes. */
    thresholdDays:   number;
  }): TaskHandoff {
    const createdAt   = new Date().toISOString();
    const nextCheckAt = addDaysIso(createdAt, input.thresholdDays);
    const handoff: TaskHandoff = {
      handoffId:        randomUUID(),
      taskId:           input.taskId,
      fromUserId:       input.fromUserId,
      toUserIds:        input.toUserIds,
      priorAssignees:   input.priorAssignees,
      note:             input.note,
      createdAt,
      ackAt:            null,
      ackUserId:        null,
      completedAt:      null,
      completedReason:  null,
      nextCheckAt,
      lastAlertAt:      null,
      alertCount:       0,
    };
    getCoreDb()
      .prepare(
        `INSERT INTO task_handoffs (
           handoff_id, task_id, from_user_id, to_user_ids, prior_assignees, note,
           created_at, next_check_at, alert_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        handoff.handoffId,
        handoff.taskId,
        handoff.fromUserId,
        JSON.stringify(handoff.toUserIds),
        JSON.stringify(handoff.priorAssignees),
        handoff.note,
        handoff.createdAt,
        handoff.nextCheckAt,
      );
    return handoff;
  }

  /** Record an acknowledgement. Resets `next_check_at` to `now + thresholdDays`
   *  but leaves `completed_at` alone — ack does not complete the handoff. */
  acknowledge(handoffId: string, userId: string, thresholdDays: number): TaskHandoff | null {
    const now = new Date().toISOString();
    const next = addDaysIso(now, thresholdDays);
    const result = getCoreDb()
      .prepare(
        `UPDATE task_handoffs
            SET ack_at = ?, ack_user_id = ?, next_check_at = ?
          WHERE handoff_id = ? AND completed_at IS NULL`,
      )
      .run(now, userId, next, handoffId) as { changes: number };
    if (result.changes === 0) return null;
    return this.getById(handoffId);
  }

  /** Record that the stale-monitor fired. Re-arms the clock to `now + thresholdDays`. */
  markAlerted(handoffId: string, thresholdDays: number): TaskHandoff | null {
    const now = new Date().toISOString();
    const next = addDaysIso(now, thresholdDays);
    const result = getCoreDb()
      .prepare(
        `UPDATE task_handoffs
            SET last_alert_at = ?, alert_count = alert_count + 1, next_check_at = ?
          WHERE handoff_id = ? AND completed_at IS NULL`,
      )
      .run(now, next, handoffId) as { changes: number };
    if (result.changes === 0) return null;
    return this.getById(handoffId);
  }

  /** Close out a handoff. Sets `completed_at` and clears `next_check_at` so the
   *  monitor's partial-indexed sweep stops considering it. */
  markCompleted(handoffId: string, reason: HandoffCompletedReason): TaskHandoff | null {
    const now = new Date().toISOString();
    const result = getCoreDb()
      .prepare(
        `UPDATE task_handoffs
            SET completed_at = ?, completed_reason = ?, next_check_at = NULL
          WHERE handoff_id = ? AND completed_at IS NULL`,
      )
      .run(now, reason, handoffId) as { changes: number };
    if (result.changes === 0) return null;
    return this.getById(handoffId);
  }

  /**
   * Activity-completes-handoff: if the given actor is a target of the task's
   * pending handoff, mark that handoff completed with the given reason.
   *
   * Per locked design (workspace memory feedback): the alarm only silences on
   * real activity by a target assignee — comments + status changes count, ack
   * does not (the ack endpoint never calls this). Activity by users outside
   * the target set (handoff-er, an admin, etc.) does not silence the alarm
   * either — the point is to make sure the actual new owner engages.
   *
   * Returns the closed handoff, or null if nothing was eligible.
   */
  completeOnActivity(
    taskId:  string,
    actorId: string,
    reason:  'status_change' | 'comment',
  ): TaskHandoff | null {
    const pending = this.getPendingForTask(taskId);
    if (!pending) return null;
    if (!pending.toUserIds.includes(actorId)) return null;
    return this.markCompleted(pending.handoffId, reason);
  }
}
