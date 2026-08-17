export type TaskNotifType =
  | 'assigned'
  | 'mentioned'
  | 'status_changed'
  | 'commented'
  | 'handoff'              // new target assignee was just handed the task
  | 'handoff_acknowledged' // handoff-er, the target ack'd
  | 'handoff_stale'        // re-ping fired on a pending handoff with no activity
  | 'review_stale'         // re-ping fired on a task sitting in Review past the threshold
  | 'reacted';             // someone put an emoji reaction on your comment

export interface TaskNotification {
  notifId: string;
  userId: string;
  type: TaskNotifType;
  taskId: string;
  taskTitle: string;
  fromUserId?: string;
  fromName?: string;
  /** Set only when type='reacted' — the emoji that was added. */
  emoji?: string;
  read: boolean;
  createdAt: string;
}
