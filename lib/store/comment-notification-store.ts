import { randomUUID } from 'node:crypto';
import type { CommentNotification, CommentNotifType } from '@/lib/models/comment-notification';
import { getCoreDb } from './core-db';

interface NotifRow {
  notif_id:     string;
  user_id:      string;
  type:         string;
  project_id:   string;
  asset_id:     string;
  asset_name:   string;
  comment_id:   string;
  from_user_id: string | null;
  from_name:    string | null;
  snippet:      string | null;
  read:         number;
  created_at:   string;
}

function rowToNotif(row: NotifRow): CommentNotification {
  return {
    notifId:    row.notif_id,
    userId:     row.user_id,
    type:       row.type as CommentNotifType,
    projectId:  row.project_id,
    assetId:    row.asset_id,
    assetName:  row.asset_name,
    commentId:  row.comment_id,
    fromUserId: row.from_user_id ?? undefined,
    fromName:   row.from_name    ?? undefined,
    snippet:    row.snippet      ?? undefined,
    read:       row.read === 1,
    createdAt:  row.created_at,
  };
}

export class CommentNotificationStore {
  getForUser(userId: string, limit = 50): CommentNotification[] {
    const rows = getCoreDb()
      .prepare(`SELECT * FROM comment_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(userId, limit) as NotifRow[];
    return rows.map(rowToNotif);
  }

  getUnreadCount(userId: string): number {
    const row = getCoreDb()
      .prepare(`SELECT COUNT(*) as cnt FROM comment_notifications WHERE user_id = ? AND read = 0`)
      .get(userId) as { cnt: number };
    return row.cnt;
  }

  create(input: {
    userId:      string;
    type:        CommentNotifType;
    projectId:   string;
    assetId:     string;
    assetName:   string;
    commentId:   string;
    fromUserId?: string;
    fromName?:   string;
    snippet?:    string;
  }): CommentNotification {
    const notif: CommentNotification = {
      notifId:    randomUUID(),
      userId:     input.userId,
      type:       input.type,
      projectId:  input.projectId,
      assetId:    input.assetId,
      assetName:  input.assetName,
      commentId:  input.commentId,
      fromUserId: input.fromUserId,
      fromName:   input.fromName,
      snippet:    input.snippet,
      read:       false,
      createdAt:  new Date().toISOString(),
    };
    getCoreDb()
      .prepare(`
        INSERT INTO comment_notifications
          (notif_id, user_id, type, project_id, asset_id, asset_name, comment_id, from_user_id, from_name, snippet, read, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `)
      .run(
        notif.notifId,
        notif.userId,
        notif.type,
        notif.projectId,
        notif.assetId,
        notif.assetName,
        notif.commentId,
        notif.fromUserId ?? null,
        notif.fromName   ?? null,
        notif.snippet    ?? null,
        notif.createdAt,
      );
    return notif;
  }

  markRead(notifId: string): void {
    getCoreDb()
      .prepare(`UPDATE comment_notifications SET read = 1 WHERE notif_id = ?`)
      .run(notifId);
  }

  markAllRead(userId: string): void {
    getCoreDb()
      .prepare(`UPDATE comment_notifications SET read = 1 WHERE user_id = ?`)
      .run(userId);
  }
}
