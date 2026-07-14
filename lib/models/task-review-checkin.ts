/**
 * Task review check-in — machine-readable state for the "sitting in Review too
 * long" nudge, modelled on the handoff stale flow ([[task-handoff]]).
 *
 * A check-in is opened when an Editing task moves INTO the `in_review` status.
 * While it's pending the ReviewStaleMonitor re-pings the task's assignees every
 * `threshold` days. Unlike a handoff, *activity does not complete it* — a
 * comment or an explicit Acknowledge only RESETS the clock, because a task
 * legitimately still in Review should keep being watched. The check-in only
 * COMPLETES when the task leaves Review (status change / terminal / delete) or
 * is reassigned via handoff (the handoff's own monitor takes over from there).
 *
 * The companion human-readable artifact is a `task_comments` row with
 * kind='review_ack' written each time someone acknowledges.
 *
 * Lifecycle:
 *   1. Opened     — task entered in_review; next_check_at = opened_at + threshold
 *   2. Reset      — comment / assignee change / Acknowledge; next_check_at re-armed
 *   3. Re-pinged  — monitor fired; alert_count +1, last_alert_at set, clock re-armed
 *   4. Completed  — left review / reassigned / deleted; completed_* set, clock cleared
 */

/** The Editing status that a check-in watches. Edit-dashboard only (see request). */
export const REVIEW_STATUS = 'in_review' as const;

export type ReviewCheckinCompletedReason =
  | 'status_change'  // moved out of in_review (incl. terminal 'done')
  | 'handoff'        // reassigned via handoff — handoff monitor takes over
  | 'task_deleted'   // referenced task no longer exists
  | 'manual';        // reserved for an explicit cancel affordance (not in v1)

export interface TaskReviewCheckin {
  checkinId:        string;
  taskId:           string;
  openedAt:         string;
  lastAckAt:        string | null;
  lastAckUserId:    string | null;
  completedAt:      string | null;
  completedReason:  ReviewCheckinCompletedReason | null;
  nextCheckAt:      string | null;
  lastAlertAt:      string | null;
  alertCount:       number;
}
