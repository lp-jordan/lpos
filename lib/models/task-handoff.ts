/**
 * Task handoff — explicit chain-of-custody event on a task.
 *
 * The companion row in `task_comments` (kind='handoff') is the human-readable
 * artifact rendered in the updates thread. This object is the machine-readable
 * state the HandoffStaleMonitor and the activity hooks read from.
 *
 * Lifecycle:
 *   1. Created — `ack_at` null, `completed_at` null, `next_check_at` = created_at + threshold
 *   2. Acknowledged (optional) — `ack_at` set, `next_check_at` reset to ack_at + threshold
 *   3. Re-pinged (zero or more times) — `last_alert_at` bumped, `alert_count` +1, `next_check_at` re-armed
 *   4. Completed — `completed_at` + `completed_reason` set, `next_check_at` cleared
 *
 * Completed reasons:
 *   - 'status_change' : a target assignee changed the task status
 *   - 'comment'       : a target assignee posted a regular comment (NOT handoff_ack)
 *   - 'next_handoff'  : the chain advanced via a fresh handoff while this one was pending
 *   - 'manual'        : reserved for an explicit cancel/revert affordance (not in v1)
 */

export type HandoffCompletedReason =
  | 'status_change'
  | 'comment'
  | 'next_handoff'
  | 'manual';

export interface TaskHandoff {
  handoffId:        string;
  taskId:           string;
  fromUserId:       string;
  toUserIds:        string[];
  priorAssignees:   string[];
  note:             string;
  createdAt:        string;
  ackAt:            string | null;
  ackUserId:        string | null;
  completedAt:      string | null;
  completedReason:  HandoffCompletedReason | null;
  nextCheckAt:      string | null;
  lastAlertAt:      string | null;
  alertCount:       number;
}
