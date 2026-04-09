export type TaskNotifType = 'assigned' | 'mentioned' | 'status_changed' | 'commented';

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
