import { randomUUID } from 'node:crypto';
import type {
  DeliveryNotification,
  DeliveryNotifType,
} from '@/lib/models/delivery-notification';
import { getCoreDb } from './core-db';

interface NotifRow {
  notif_id:        string;
  user_id:         string;
  type:            string;
  delivery_token:  string;
  project_name:    string;
  client_name:     string | null;
  label:           string | null;
  description:     string | null;
  queue_summary:   string | null;
  user_agent:      string | null;
  href:            string | null;
  read:            number;
  created_at:      string;
}

function rowToNotif(row: NotifRow): DeliveryNotification {
  return {
    notifId:       row.notif_id,
    userId:        row.user_id,
    type:          row.type as DeliveryNotifType,
    deliveryToken: row.delivery_token,
    projectName:   row.project_name,
    clientName:    row.client_name,
    label:         row.label,
    description:   row.description,
    queueSummary:  row.queue_summary,
    userAgent:     row.user_agent,
    href:          row.href,
    read:          row.read === 1,
    createdAt:     row.created_at,
  };
}

export class DeliveryNotificationStore {
  getForUser(userId: string, limit = 50): DeliveryNotification[] {
    const rows = getCoreDb()
      .prepare(
        'SELECT * FROM delivery_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(userId, limit) as NotifRow[];
    return rows.map(rowToNotif);
  }

  getUnreadCount(userId: string): number {
    const row = getCoreDb()
      .prepare(
        'SELECT COUNT(*) as cnt FROM delivery_notifications WHERE user_id = ? AND read = 0',
      )
      .get(userId) as { cnt: number };
    return row.cnt;
  }

  create(input: {
    userId:        string;
    type:          DeliveryNotifType;
    deliveryToken: string;
    projectName:   string;
    clientName:    string | null;
    label:         string | null;
    description:   string | null;
    queueSummary:  string | null;
    userAgent:     string | null;
    href:          string | null;
  }): DeliveryNotification {
    const notif: DeliveryNotification = {
      notifId:       randomUUID(),
      userId:        input.userId,
      type:          input.type,
      deliveryToken: input.deliveryToken,
      projectName:   input.projectName,
      clientName:    input.clientName,
      label:         input.label,
      description:   input.description,
      queueSummary:  input.queueSummary,
      userAgent:     input.userAgent,
      href:          input.href,
      read:          false,
      createdAt:     new Date().toISOString(),
    };
    getCoreDb()
      .prepare(
        `INSERT INTO delivery_notifications
           (notif_id, user_id, type, delivery_token, project_name, client_name,
            label, description, queue_summary, user_agent, href, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        notif.notifId,
        notif.userId,
        notif.type,
        notif.deliveryToken,
        notif.projectName,
        notif.clientName,
        notif.label,
        notif.description,
        notif.queueSummary,
        notif.userAgent,
        notif.href,
        notif.createdAt,
      );
    return notif;
  }

  markRead(notifId: string): void {
    getCoreDb()
      .prepare('UPDATE delivery_notifications SET read = 1 WHERE notif_id = ?')
      .run(notifId);
  }

  markAllRead(userId: string): void {
    getCoreDb()
      .prepare('UPDATE delivery_notifications SET read = 1 WHERE user_id = ?')
      .run(userId);
  }
}
