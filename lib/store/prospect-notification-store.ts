import { randomUUID } from 'node:crypto';
import type { ProspectNotification, ProspectNotifType } from '@/lib/models/prospect-notification';
import { getCoreDb } from './core-db';

interface NotifRow {
  notif_id:     string;
  user_id:      string;
  type:         string;
  prospect_id:  string;
  company:      string;
  from_user_id: string | null;
  from_name:    string | null;
  read:         number;
  created_at:   string;
}

function rowToNotif(row: NotifRow): ProspectNotification {
  return {
    notifId:    row.notif_id,
    userId:     row.user_id,
    type:       row.type as ProspectNotifType,
    prospectId: row.prospect_id,
    company:    row.company,
    fromUserId: row.from_user_id ?? undefined,
    fromName:   row.from_name    ?? undefined,
    read:       row.read === 1,
    createdAt:  row.created_at,
  };
}

export class ProspectNotificationStore {
  getForUser(userId: string, limit = 50): ProspectNotification[] {
    const rows = getCoreDb()
      .prepare(`SELECT * FROM prospect_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(userId, limit) as NotifRow[];
    return rows.map(rowToNotif);
  }

  getUnreadCount(userId: string): number {
    const row = getCoreDb()
      .prepare(`SELECT COUNT(*) as cnt FROM prospect_notifications WHERE user_id = ? AND read = 0`)
      .get(userId) as { cnt: number };
    return row.cnt;
  }

  create(input: {
    userId:      string;
    type:        ProspectNotifType;
    prospectId:  string;
    company:     string;
    fromUserId?: string;
    fromName?:   string;
  }): ProspectNotification {
    const notif: ProspectNotification = {
      notifId:    randomUUID(),
      userId:     input.userId,
      type:       input.type,
      prospectId: input.prospectId,
      company:    input.company,
      fromUserId: input.fromUserId,
      fromName:   input.fromName,
      read:       false,
      createdAt:  new Date().toISOString(),
    };
    getCoreDb()
      .prepare(`
        INSERT INTO prospect_notifications
          (notif_id, user_id, type, prospect_id, company, from_user_id, from_name, read, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      `)
      .run(
        notif.notifId,
        notif.userId,
        notif.type,
        notif.prospectId,
        notif.company,
        notif.fromUserId ?? null,
        notif.fromName   ?? null,
        notif.createdAt,
      );
    return notif;
  }

  markRead(notifId: string): void {
    getCoreDb()
      .prepare(`UPDATE prospect_notifications SET read = 1 WHERE notif_id = ?`)
      .run(notifId);
  }

  markAllRead(userId: string): void {
    getCoreDb()
      .prepare(`UPDATE prospect_notifications SET read = 1 WHERE user_id = ?`)
      .run(userId);
  }
}
