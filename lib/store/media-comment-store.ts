/**
 * Media-comment store — Phase 0 of the local-first comments refactor.
 *
 * See docs/local-comments-refactor-spec.md for the full design.
 *
 * Phase 0 = shadow capture. This store:
 *   - Writes from the Frame.io webhook handler (source='frameio')
 *   - Writes from LPOS-side comment posts (source='lpos')
 *   - Surfaces row counts + recent samples to the admin shadow-status route
 *
 * The UI does NOT read from this store yet — that's Phase 1. Reads here are
 * admin-only for now.
 *
 * Idempotency: INSERT-OR-IGNORE on `frameio_comment_id UNIQUE` keeps the
 * webhook echo (our own LPOS write reflected back by Frame.io's webhook)
 * from duplicating rows. UPDATE-by-frameio-id keeps `comment.updated` /
 * `comment.completed` / `comment.deleted` events flowing without orphaning
 * the local row.
 */

import { randomUUID } from 'node:crypto';
import { getCoreDb } from './core-db';
import {
  rowToMediaComment,
  type MediaComment,
  type MediaCommentInsert,
  type MediaCommentRow,
} from '@/lib/models/media-comment';

// ── Inserts ──────────────────────────────────────────────────────────────────

/**
 * Insert a new media comment. Returns the inserted row or, if a row already
 * exists with the same `frameio_comment_id`, returns the existing row
 * (webhook echo path — see spec §6.2 step 1).
 *
 * `threadRootId` is derived: parent's root if a reply, self if top-level.
 */
export function insertMediaComment(input: MediaCommentInsert): MediaComment {
  const db = getCoreDb();

  // Webhook-echo short-circuit: if Frame.io is reporting back a comment we
  // already mirrored (or that arrived in a prior webhook), don't double-insert.
  if (input.frameioCommentId) {
    const existing = db.prepare('SELECT * FROM media_comments WHERE frameio_comment_id = ?')
      .get(input.frameioCommentId) as MediaCommentRow | undefined;
    if (existing) return rowToMediaComment(existing);
  }

  const commentId: string = randomUUID();
  const now               = input.createdAtOverride ?? new Date().toISOString();

  let threadRootId: string = commentId;
  if (input.parentCommentId) {
    const parent = db.prepare('SELECT thread_root_id FROM media_comments WHERE comment_id = ?')
      .get(input.parentCommentId) as { thread_root_id: string } | undefined;
    threadRootId = parent?.thread_root_id ?? input.parentCommentId;
  }

  db.prepare(
    `INSERT INTO media_comments (
       comment_id, project_id, asset_id, asset_version_id,
       parent_comment_id, thread_root_id,
       body, timestamp_seconds, duration_seconds,
       author_user_id, author_external_name, author_external_email, author_avatar_url,
       source, frameio_comment_id, frameio_file_id,
       completed, completed_at, completed_by_user_id,
       created_at, updated_at, deleted_at
     ) VALUES (
       ?, ?, ?, ?,
       ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?,
       ?, NULL, NULL,
       ?, ?, NULL
     )`,
  ).run(
    commentId, input.projectId, input.assetId, input.assetVersionId,
    input.parentCommentId ?? null, threadRootId,
    input.body, input.timestampSeconds ?? null, input.durationSeconds ?? null,
    input.authorUserId ?? null, input.authorExternalName ?? null, input.authorExternalEmail ?? null, input.authorAvatarUrl ?? null,
    input.source, input.frameioCommentId ?? null, input.frameioFileId ?? null,
    input.completed ? 1 : 0,
    now, now,
  );

  const row = db.prepare('SELECT * FROM media_comments WHERE comment_id = ?').get(commentId) as MediaCommentRow;
  return rowToMediaComment(row);
}

// ── Lookups ──────────────────────────────────────────────────────────────────

export function getMediaCommentByFrameioId(frameioCommentId: string): MediaComment | null {
  const db = getCoreDb();
  const row = db.prepare('SELECT * FROM media_comments WHERE frameio_comment_id = ?')
    .get(frameioCommentId) as MediaCommentRow | undefined;
  return row ? rowToMediaComment(row) : null;
}

export function getMediaCommentById(commentId: string): MediaComment | null {
  const db = getCoreDb();
  const row = db.prepare('SELECT * FROM media_comments WHERE comment_id = ?')
    .get(commentId) as MediaCommentRow | undefined;
  return row ? rowToMediaComment(row) : null;
}

// ── Updates ──────────────────────────────────────────────────────────────────

/**
 * Update a comment's body. Called from the route handler after a successful
 * Frame.io PATCH; locked decision §11 #6 = LWW by `updatedAt` — webhook
 * receiver and outbound caller can race and last write wins.
 *
 * Lookup is by `frameio_comment_id` because today's PATCH route only knows
 * the Frame.io ID. Once Phase 2 ships local-first writes, callers will hit
 * `updateMediaCommentTextByLocalId` instead.
 */
export function updateMediaCommentTextByFrameioId(frameioCommentId: string, newBody: string): MediaComment | null {
  const db = getCoreDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE media_comments
        SET body = ?, updated_at = ?
      WHERE frameio_comment_id = ?`,
  ).run(newBody, now, frameioCommentId);
  return getMediaCommentByFrameioId(frameioCommentId);
}

/**
 * Flip completion state. `completedByUserId` is recorded only when an LPOS
 * user toggled (i.e. we know the actor); webhook-driven flips pass null.
 */
export function setMediaCommentCompletedByFrameioId(
  frameioCommentId: string,
  completed: boolean,
  completedByUserId: string | null,
): MediaComment | null {
  const db = getCoreDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE media_comments
        SET completed = ?,
            completed_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
            completed_by_user_id = CASE WHEN ? = 1 THEN ? ELSE NULL END,
            updated_at = ?
      WHERE frameio_comment_id = ?`,
  ).run(
    completed ? 1 : 0,
    completed ? 1 : 0, now,
    completed ? 1 : 0, completedByUserId,
    now,
    frameioCommentId,
  );
  return getMediaCommentByFrameioId(frameioCommentId);
}

/**
 * Soft delete (locked decision §11 #8). Phase 4+ may switch to hard delete
 * when LPOS becomes the canonical source of truth — but for now we preserve
 * the row so the editpanel marker tether stays addressable even if a
 * delete-mirror to Frame.io fails.
 */
export function softDeleteMediaCommentByFrameioId(frameioCommentId: string): MediaComment | null {
  const db = getCoreDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE media_comments
        SET deleted_at = ?, updated_at = ?
      WHERE frameio_comment_id = ?`,
  ).run(now, now, frameioCommentId);
  return getMediaCommentByFrameioId(frameioCommentId);
}

// ── Phase 1 reads ────────────────────────────────────────────────────────────

/**
 * Threaded comment shape returned to the existing comments UI. Same shape the
 * legacy `getComments(fileId)` returned, so route handlers can swap their
 * data source without touching the renderers. `id` is the Frame.io comment
 * id when present (preserves the editpanel marker tether + existing
 * PATCH/DELETE callers that address comments by Frame.io id); falls back
 * to the local `comment_id` for LPOS-only comments (rare in Phase 1, may
 * happen if a comment was captured by shadow-write before its mirror
 * landed).
 */
export interface ThreadedMediaComment {
  id:           string;
  text:         string;
  timestamp:    number | null;
  duration:     number | null;
  authorName:   string;
  authorAvatar: string | null;
  createdAt:    string;
  completed:    boolean;
  replies: Array<{
    id:           string;
    text:         string;
    authorName:   string;
    authorAvatar: string | null;
    createdAt:    string;
  }>;
}

/**
 * Phase 1 read: every comment for one (asset, version) tuple, in the
 * threaded shape the UI expects. Filters soft-deleted rows. Sort order:
 * top-level comments by created_at ASC (oldest first, matches today's
 * Frame.io GET behavior); replies likewise.
 *
 * `assetVersionId` is required by locked decision §11 #1 — comments are
 * version-scoped. Phase 2's version-cycler UI will pass the version the
 * user selected; until then, callers pass the current version's id (or
 * just the latest known via `findAssetVersionByFrameioFileId(currentFileId)`).
 *
 * Note on author resolution: this returns raw `author_external_name` /
 * `author_user_id` info; the route handler is responsible for replacing
 * `author_user_id` with the real LPOS user's display name (the legacy
 * `comment-authors.json` shim has been merged into the row during Phase 0
 * shadow capture, but the user-store lookup still happens at request time
 * so a renamed user displays the current name).
 */
export interface ThreadedReadResult {
  comments: ThreadedMediaComment[];
  /** Local row info needed by the route handler for author resolution + edit-permission checks. */
  rowLookup: Map<string, { authorUserId: string | null; authorExternalName: string | null; commentId: string }>;
}

export function getThreadedCommentsForAssetVersion(
  projectId:      string,
  assetId:        string,
  assetVersionId: string,
): ThreadedReadResult {
  const db = getCoreDb();
  const rows = db.prepare(
    `SELECT * FROM media_comments
      WHERE project_id = ?
        AND asset_id = ?
        AND asset_version_id = ?
        AND deleted_at IS NULL
      ORDER BY thread_root_id, created_at ASC`,
  ).all(projectId, assetId, assetVersionId) as MediaCommentRow[];

  // Group by thread root. Map<threadRootId, { root: row | null, replies: row[] }>.
  // The query orders by thread_root_id + created_at ASC, so the root of each
  // thread (which has thread_root_id === comment_id) appears before its replies.
  const byThread = new Map<string, { root: MediaCommentRow | null; replies: MediaCommentRow[] }>();
  for (const row of rows) {
    const bucket = byThread.get(row.thread_root_id) ?? { root: null, replies: [] };
    if (row.comment_id === row.thread_root_id) bucket.root = row;
    else                                       bucket.replies.push(row);
    byThread.set(row.thread_root_id, bucket);
  }

  const rowLookup = new Map<string, { authorUserId: string | null; authorExternalName: string | null; commentId: string }>();
  const comments: ThreadedMediaComment[] = [];

  for (const { root, replies } of byThread.values()) {
    if (!root) continue;  // orphan reply (parent was soft-deleted) — drop for now

    const rootId = root.frameio_comment_id ?? root.comment_id;
    rowLookup.set(rootId, {
      authorUserId:       root.author_user_id,
      authorExternalName: root.author_external_name,
      commentId:          root.comment_id,
    });

    const replyOut = replies.map((r) => {
      const rId = r.frameio_comment_id ?? r.comment_id;
      rowLookup.set(rId, {
        authorUserId:       r.author_user_id,
        authorExternalName: r.author_external_name,
        commentId:          r.comment_id,
      });
      return {
        id:           rId,
        text:         r.body,
        authorName:   r.author_external_name ?? '',
        authorAvatar: r.author_avatar_url,
        createdAt:    r.created_at,
      };
    });

    comments.push({
      id:           rootId,
      text:         root.body,
      timestamp:    root.timestamp_seconds,
      duration:     root.duration_seconds,
      authorName:   root.author_external_name ?? '',
      authorAvatar: root.author_avatar_url,
      createdAt:    root.created_at,
      completed:    root.completed === 1,
      replies:      replyOut,
    });
  }

  // Sort threads by root createdAt ASC for stable display order.
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return { comments, rowLookup };
}

/**
 * Phase 1 supporting query for the "Latest comments" sort on the project
 * media tab. Replaces the broken-in-prod `activity_events`-based
 * `getLatestCommentByAssetForProject` (per memory: 0 frameio.comment.* rows
 * because webhook isn't firing). Reading directly from `media_comments`
 * doesn't depend on the activity pipeline at all.
 *
 * Returns Map<assetId, ISO timestamp of most recent comment on that asset>.
 * Excludes soft-deleted rows. Spans all versions of each asset (locked
 * decision §11 #1 — sort uses latest comment across ALL versions so it
 * doesn't go stale when v3 supersedes v2).
 */
export function getLatestMediaCommentByAssetForProject(projectId: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!projectId) return result;
  const db = getCoreDb();
  const rows = db.prepare(
    `SELECT asset_id AS assetId, MAX(created_at) AS latest
       FROM media_comments
      WHERE project_id = ?
        AND deleted_at IS NULL
      GROUP BY asset_id`,
  ).all(projectId) as Array<{ assetId: string; latest: string | null }>;
  for (const row of rows) {
    if (row.latest) result.set(row.assetId, row.latest);
  }
  return result;
}

// ── Admin shadow-status ──────────────────────────────────────────────────────

export interface MediaCommentShadowStatus {
  total:           number;
  bySource:        Record<'lpos' | 'frameio', number>;
  withFrameioId:   number;
  topLevel:        number;
  replies:         number;
  softDeleted:     number;
  recentSamples:   MediaComment[];
  perProjectCounts: Array<{ projectId: string; count: number }>;
}

/**
 * Snapshot of the shadow-capture table for the admin status route. Used to
 * verify Phase 0 is capturing correctly before Phase 1 swaps the UI's
 * read path over.
 */
export function getMediaCommentShadowStatus(sampleSize = 10): MediaCommentShadowStatus {
  const db = getCoreDb();

  const total       = (db.prepare('SELECT count(*) AS n FROM media_comments').get() as { n: number }).n;
  const lposCount   = (db.prepare("SELECT count(*) AS n FROM media_comments WHERE source = 'lpos'").get()    as { n: number }).n;
  const frameioCount = (db.prepare("SELECT count(*) AS n FROM media_comments WHERE source = 'frameio'").get() as { n: number }).n;
  const withFrameioId = (db.prepare('SELECT count(*) AS n FROM media_comments WHERE frameio_comment_id IS NOT NULL').get() as { n: number }).n;
  const topLevel    = (db.prepare('SELECT count(*) AS n FROM media_comments WHERE parent_comment_id IS NULL').get() as { n: number }).n;
  const replies     = (db.prepare('SELECT count(*) AS n FROM media_comments WHERE parent_comment_id IS NOT NULL').get() as { n: number }).n;
  const softDeleted = (db.prepare('SELECT count(*) AS n FROM media_comments WHERE deleted_at IS NOT NULL').get() as { n: number }).n;

  const recentRows = db.prepare(
    'SELECT * FROM media_comments ORDER BY created_at DESC LIMIT ?',
  ).all(sampleSize) as MediaCommentRow[];

  const perProjectRows = db.prepare(
    `SELECT project_id AS projectId, count(*) AS count
       FROM media_comments
      GROUP BY project_id
      ORDER BY count DESC
      LIMIT 20`,
  ).all() as Array<{ projectId: string; count: number }>;

  return {
    total,
    bySource: { lpos: lposCount, frameio: frameioCount },
    withFrameioId,
    topLevel,
    replies,
    softDeleted,
    recentSamples: recentRows.map(rowToMediaComment),
    perProjectCounts: perProjectRows,
  };
}
