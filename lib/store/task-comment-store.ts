import { randomUUID } from 'node:crypto';
import type { TaskComment, TaskCommentAttachment, TaskCommentKind } from '@/lib/models/task-comment';
import { getCoreDb, withTransaction } from './core-db';

interface CommentRow {
  comment_id:  string;
  task_id:     string;
  body:        string;
  author_id:   string;
  created_at:  string;
  edited_at:   string | null;
  attachments: string;          // JSON
  kind:        string;          // 'comment' | 'handoff' | 'handoff_ack'
  metadata:    string | null;   // JSON or null
}

function rowToComment(row: CommentRow, mentions: string[]): TaskComment {
  let attachments: TaskCommentAttachment[] = [];
  try { attachments = JSON.parse(row.attachments || '[]') as TaskCommentAttachment[]; } catch { /* */ }
  let metadata: TaskComment['metadata'];
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata) as TaskComment['metadata']; } catch { metadata = undefined; }
  }
  return {
    commentId:   row.comment_id,
    taskId:      row.task_id,
    body:        row.body,
    authorId:    row.author_id,
    mentions,
    createdAt:   row.created_at,
    editedAt:    row.edited_at ?? undefined,
    attachments,
    kind:        (row.kind ?? 'comment') as TaskCommentKind,
    metadata,
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
    taskId:      string;
    body:        string;
    authorId:    string;
    mentions:    string[];
    attachments?: TaskCommentAttachment[];
    /** Defaults to 'comment' for plain user updates. Use 'handoff' / 'handoff_ack'
     *  when writing typed system entries from the handoff endpoints. */
    kind?:       TaskCommentKind;
    /** Structured payload (shape depends on `kind`); ignored when kind='comment'. */
    metadata?:   Record<string, unknown>;
  }): TaskComment {
    const db          = getCoreDb();
    const attachments = input.attachments ?? [];
    const kind        = input.kind ?? 'comment';
    const metadata    = input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined;
    const comment: TaskComment = {
      commentId:   randomUUID(),
      taskId:      input.taskId,
      body:        input.body.trim(),
      authorId:    input.authorId,
      mentions:    input.mentions,
      createdAt:   new Date().toISOString(),
      attachments,
      kind,
      metadata,
    };
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO task_comments (comment_id, task_id, body, author_id, created_at, attachments, kind, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        comment.commentId,
        comment.taskId,
        comment.body,
        comment.authorId,
        comment.createdAt,
        JSON.stringify(attachments),
        kind,
        metadata ? JSON.stringify(metadata) : null,
      );
      for (const userId of comment.mentions) {
        db.prepare(
          'INSERT OR IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?, ?)',
        ).run(comment.commentId, userId);
      }
    });
    return comment;
  }

  /**
   * Edit a comment's body text. Only succeeds if requesterId is the author and
   * the entry is a plain 'comment' (handoff / handoff_ack entries are system
   * records and are not editable). Replaces the mention set and stamps
   * `edited_at`. Returns the updated comment, or null if not permitted.
   */
  update(commentId: string, requesterId: string, body: string, mentions: string[]): TaskComment | null {
    const existing = this.getById(commentId);
    if (!existing || existing.authorId !== requesterId || existing.kind !== 'comment') return null;

    const trimmed  = body.trim();
    if (!trimmed) return null;
    const editedAt = new Date().toISOString();

    const db = getCoreDb();
    withTransaction(db, () => {
      db.prepare(
        'UPDATE task_comments SET body = ?, edited_at = ? WHERE comment_id = ?',
      ).run(trimmed, editedAt, commentId);
      db.prepare('DELETE FROM comment_mentions WHERE comment_id = ?').run(commentId);
      for (const userId of mentions) {
        db.prepare(
          'INSERT OR IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?, ?)',
        ).run(commentId, userId);
      }
    });

    return { ...existing, body: trimmed, mentions, editedAt };
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
