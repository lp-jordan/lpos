export type TaskNotifType =
  | 'assigned'
  | 'mentioned'
  | 'status_changed'
  | 'commented'
  | 'handoff'              // new target assignee was just handed the task
  | 'handoff_acknowledged' // handoff-er, the target ack'd
  | 'handoff_stale';       // re-ping fired on a pending handoff with no activity

export interface TaskNotification {
  notifId: string;
  userId: string;
  type: TaskNotifType;
  taskId: string;
  taskTitle: string;
  fromUserId?: string;
  fromName?: string;
  read: boolean;
  createdAt: string;
}
