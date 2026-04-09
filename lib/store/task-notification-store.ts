import { randomUUID } from 'node:crypto';
import type { TaskNotification, TaskNotifType } from '@/lib/models/task-notification';
import { getCoreDb } from './core-db';

interface NotifRow {
  notif_id: string;
  user_id: string;
  type: string;
  task_id: string;
  task_title: string;
  from_user_id: string | null;
  from_name: string | null;
  read: number;
  created_at: string;
}

function rowToNotif(row: NotifRow): TaskNotification {
  return {
    notifId: row.notif_id,
    userId: row.user_id,
    type: row.type as TaskNotifType,
    taskId: row.task_id,
    taskTitle: row.task_title,
    fromUserId: row.from_user_id ?? undefined,
    fromName: row.from_name ?? undefined,
    read: row.read === 1,
    createdAt: row.created_at,
  };
}

export class TaskNotificationStore {
  getForUser(userId: string, limit = 50): TaskNotification[] {
    const rows = getCoreDb()
      .prepare(
        'SELECT * FROM task_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(userId, limit) as NotifRow[];
    return rows.map(rowToNotif);
  }

  getUnreadCount(userId: string): number {
    const row = getCoreDb()
      .prepare(
        'SELECT COUNT(*) as cnt FROM task_notifications WHERE user_id = ? AND read = 0',
      )
      .get(userId) as { cnt: number };
    return row.cnt;
  }

  create(input: {
    userId: string;
    type: TaskNotifType;
    taskId: string;
    taskTitle: string;
    fromUserId?: string;
    fromName?: string;
  }): TaskNotification {
    const notif: TaskNotification = {
      notifId: randomUUID(),
      userId: input.userId,
      type: input.type,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      fromUserId: input.fromUserId,
      fromName: input.fromName,
      read: false,
      createdAt: new Date().toISOString(),
    };
    getCoreDb()
      .prepare(
        `INSERT INTO task_notifications
           (notif_id, user_id, type, task_id, task_title, from_user_id, from_name, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        notif.notifId,
        notif.userId,
        notif.type,
        notif.taskId,
        notif.taskTitle,
        notif.fromUserId ?? null,
        notif.fromName ?? null,
        notif.createdAt,
      );
    return notif;
  }

  markRead(notifId: string): void {
    getCoreDb()
      .prepare('UPDATE task_notifications SET read = 1 WHERE notif_id = ?')
      .run(notifId);
  }

  markAllRead(userId: string): void {
    getCoreDb()
      .prepare('UPDATE task_notifications SET read = 1 WHERE user_id = ?')
      .run(userId);
  }
}
