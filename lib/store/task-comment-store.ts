import { randomUUID } from 'node:crypto';
import type { TaskComment } from '@/lib/models/task-comment';
import { getCoreDb, withTransaction } from './core-db';

interface CommentRow {
  comment_id: string;
  task_id: string;
  body: string;
  author_id: string;
  created_at: string;
  edited_at: string | null;
}

function rowToComment(row: CommentRow, mentions: string[]): TaskComment {
  return {
    commentId: row.comment_id,
    taskId: row.task_id,
    body: row.body,
    authorId: row.author_id,
    mentions,
    createdAt: row.created_at,
    editedAt: row.edited_at ?? undefined,
  };
}

export class TaskCommentStore {
  getForTask(taskId: string): TaskComment[] {
    const db = getCoreDb();
    const rows = db
      .prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as CommentRow[];
    if (rows.length === 0) return [];
    const mentionRows = db
      .prepare(
        `SELECT comment_id, user_id FROM comment_mentions
         WHERE comment_id IN (${rows.map(() => '?').join(', ')})`,
      )
      .all(...rows.map((r) => r.comment_id)) as { comment_id: string; user_id: string }[];
    const mentionMap = new Map<string, string[]>();
    for (const m of mentionRows) {
      const arr = mentionMap.get(m.comment_id) ?? [];
      arr.push(m.user_id);
      mentionMap.set(m.comment_id, arr);
    }
    return rows.map((r) => rowToComment(r, mentionMap.get(r.comment_id) ?? []));
  }

  getById(commentId: string): TaskComment | null {
    const db = getCoreDb();
    const row = db
      .prepare('SELECT * FROM task_comments WHERE comment_id = ?')
      .get(commentId) as CommentRow | undefined;
    if (!row) return null;
    const mentions = (
      db
        .prepare('SELECT user_id FROM comment_mentions WHERE comment_id = ?')
        .all(commentId) as { user_id: string }[]
    ).map((r) => r.user_id);
    return rowToComment(row, mentions);
  }

  create(input: {
    taskId: string;
    body: string;
    authorId: string;
    mentions: string[];
  }): TaskComment {
    const db = getCoreDb();
    const comment: TaskComment = {
      commentId: randomUUID(),
      taskId: input.taskId,
      body: input.body.trim(),
      authorId: input.authorId,
      mentions: input.mentions,
      createdAt: new Date().toISOString(),
    };
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO task_comments (comment_id, task_id, body, author_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(comment.commentId, comment.taskId, comment.body, comment.authorId, comment.createdAt);
      for (const userId of comment.mentions) {
        db.prepare(
          'INSERT OR IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?, ?)',
        ).run(comment.commentId, userId);
      }
    });
    return comment;
  }

  /** Returns true if deleted. Only succeeds if requesterId is the author. */
  delete(commentId: string, requesterId: string): boolean {
    const existing = this.getById(commentId);
    if (!existing || existing.authorId !== requesterId) return false;
    const result = getCoreDb()
      .prepare('DELETE FROM task_comments WHERE comment_id = ?')
      .run(commentId) as { changes: number };
    return result.changes > 0;
  }

  getCountForTask(taskId: string): number {
    const row = getCoreDb()
      .prepare('SELECT COUNT(*) as cnt FROM task_comments WHERE task_id = ?')
      .get(taskId) as { cnt: number };
    return row.cnt;
  }
}
