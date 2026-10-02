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
  share_id?:      string | null;
  share_token?:   string | null;
  share_name?:    string | null;
  session_key?:   string | null;
  comment_count?: number | null;
  asset_ids?:     string | null;
}

function assetIdsOf(row: Pick<NotifRow, 'asset_ids'>): string[] {
  try { return row.asset_ids ? JSON.parse(row.asset_ids) as string[] : []; } catch { return []; }
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
    ...(row.type === 'share_activity' ? {
      shareId:      row.share_id ?? undefined,
      shareToken:   row.share_token ?? undefined,
      shareName:    row.share_name ?? undefined,
      commentCount: row.comment_count ?? 1,
      assetCount:   Math.max(1, assetIdsOf(row).length),
    } : {}),
    ...(row.type === 'share_open' ? {
      shareId:     row.share_id ?? undefined,
      shareToken:  row.share_token ?? undefined,
      shareName:   row.share_name ?? undefined,
      viewerCount: row.comment_count ?? 1,
      viewerKind:  (row.snippet === 'email' ? 'email' : 'visitor') as 'email' | 'visitor',
      snippet:     undefined,
    } : {}),
  };
}

/** A review session goes quiet after this long; the next comment starts a new bell item. */
export const SHARE_SESSION_WINDOW_MS = 30 * 60 * 1000;

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

  /**
   * Record one client comment in the recipient's rolling share_activity item:
   * update the session's row if its last comment was within the window, else
   * start a new row. Returns the item as it now is, and whether it's new.
   */
  upsertShareActivity(input: {
    userId:     string;
    sessionKey: string;
    shareId:    string;
    shareToken: string;
    shareName:  string;
    projectId:  string;
    assetId:    string;
    assetName:  string;
    commentId:  string;
    fromName:   string;
    snippet:    string;
    at:         string;
  }): { notif: CommentNotification; isNew: boolean } {
    const db = getCoreDb();
    const since = new Date(Date.parse(input.at) - SHARE_SESSION_WINDOW_MS).toISOString();
    const open = db.prepare(
      `SELECT * FROM comment_notifications
        WHERE user_id = ? AND session_key = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(input.userId, input.sessionKey, since) as NotifRow | undefined;

    if (open) {
      const ids = assetIdsOf(open);
      if (!ids.includes(input.assetId)) ids.push(input.assetId);
      // The item keeps pointing at the FIRST video commented on (where a
      // reviewer would start reading); counts and the snippet move forward.
      db.prepare(
        `UPDATE comment_notifications
            SET comment_count = COALESCE(comment_count, 1) + 1, asset_ids = ?, snippet = ?,
                share_name = ?, read = 0, created_at = ?
          WHERE notif_id = ?`,
      ).run(JSON.stringify(ids), input.snippet, input.shareName, input.at, open.notif_id);
      const row = db.prepare('SELECT * FROM comment_notifications WHERE notif_id = ?').get(open.notif_id) as NotifRow;
      return { notif: rowToNotif(row), isNew: false };
    }

    const notifId = randomUUID();
    db.prepare(
      `INSERT INTO comment_notifications
         (notif_id, user_id, type, project_id, asset_id, asset_name, comment_id, from_user_id, from_name, snippet, read, created_at,
          share_id, share_token, share_name, session_key, comment_count, asset_ids)
       VALUES (?, ?, 'share_activity', ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      notifId, input.userId, input.projectId, input.assetId, input.assetName, input.commentId, input.fromName, input.snippet, input.at,
      input.shareId, input.shareToken, input.shareName, input.sessionKey, JSON.stringify([input.assetId]),
    );
    const row = db.prepare('SELECT * FROM comment_notifications WHERE notif_id = ?').get(notifId) as NotifRow;
    return { notif: rowToNotif(row), isNew: true };
  }

  /**
   * Record someone's first open of a share in the recipient's rolling
   * share_open item: fold into the share's item if it was touched within the
   * window, else start a new one. comment_count holds the viewer count and
   * snippet the latest viewer's kind ('email' | 'visitor').
   */
  upsertShareOpen(input: {
    userId:     string;
    shareId:    string;
    shareToken: string;
    shareName:  string;
    viewer:     string;
    viewerKind: 'email' | 'visitor';
    at:         string;
  }): { notif: CommentNotification; isNew: boolean } {
    const db = getCoreDb();
    const sessionKey = `open:${input.shareId}`;
    const since = new Date(Date.parse(input.at) - SHARE_SESSION_WINDOW_MS).toISOString();
    const open = db.prepare(
      `SELECT notif_id FROM comment_notifications
        WHERE user_id = ? AND session_key = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(input.userId, sessionKey, since) as { notif_id: string } | undefined;

    let notifId: string;
    if (open) {
      notifId = open.notif_id;
      db.prepare(
        `UPDATE comment_notifications
            SET comment_count = COALESCE(comment_count, 1) + 1, from_name = ?, snippet = ?,
                share_name = ?, read = 0, created_at = ?
          WHERE notif_id = ?`,
      ).run(input.viewer, input.viewerKind, input.shareName, input.at, notifId);
    } else {
      notifId = randomUUID();
      db.prepare(
        `INSERT INTO comment_notifications
           (notif_id, user_id, type, project_id, asset_id, asset_name, comment_id, from_user_id, from_name, snippet, read, created_at,
            share_id, share_token, share_name, session_key, comment_count, asset_ids)
         VALUES (?, ?, 'share_open', '', '', '', '', NULL, ?, ?, 0, ?, ?, ?, ?, ?, 1, NULL)`,
      ).run(notifId, input.userId, input.viewer, input.viewerKind, input.at, input.shareId, input.shareToken, input.shareName, sessionKey);
    }
    const row = db.prepare('SELECT * FROM comment_notifications WHERE notif_id = ?').get(notifId) as NotifRow;
    return { notif: rowToNotif(row), isNew: !open };
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
