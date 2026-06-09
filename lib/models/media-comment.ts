/**
 * Media-comment model — Phase 0 of the local-first comments refactor.
 *
 * See docs/local-comments-refactor-spec.md for the full design. Phase 0 is
 * shadow capture only: this model represents what we write into the new
 * `media_comments` table from both inbound Frame.io webhooks and LPOS-side
 * comment posts. No UI consumes it yet; the spec's Phase 1 swaps the read
 * paths to use it as source of truth.
 *
 * §11 design decisions baked in:
 *   #1 (locked) — `assetVersionId` is required. Comments are version-scoped.
 *   #2 (locked) — replies stay LPOS-only; `parentCommentId` is set but the
 *                 outbound mirror never sends them to Frame.io.
 *   #6 (locked) — last-write-wins via `updatedAt`.
 *   #8 (locked) — soft delete via `deletedAt`.
 */

/** Provenance — which side produced this row. */
export type MediaCommentSource = 'lpos' | 'frameio';

/**
 * Read shape. Returned by the store and (in Phase 1+) serialised over the
 * comments API to the UI. Field names are camelCase to match the rest of the
 * dashboard's TS surface; the underlying SQLite column names are snake_case
 * — see `MediaCommentRow` below for the on-disk shape.
 */
export interface MediaComment {
  commentId:           string;
  projectId:           string;
  assetId:             string;
  assetVersionId:      string;
  parentCommentId:     string | null;
  threadRootId:        string;
  body:                string;
  timestampSeconds:    number | null;
  durationSeconds:     number | null;
  authorUserId:        string | null;
  authorExternalName:  string | null;
  authorExternalEmail: string | null;
  authorAvatarUrl:     string | null;
  source:              MediaCommentSource;
  frameioCommentId:    string | null;
  frameioFileId:       string | null;
  completed:           boolean;
  completedAt:         string | null;
  completedByUserId:   string | null;
  createdAt:           string;
  updatedAt:           string;
  deletedAt:           string | null;
}

/**
 * Raw SQLite row shape. The store maps row → MediaComment for callers.
 * Kept in this model file so any future schema column rename happens in one
 * place. `completed` is stored as 0/1 integer per SQLite convention.
 */
export interface MediaCommentRow {
  comment_id:            string;
  project_id:            string;
  asset_id:              string;
  asset_version_id:      string;
  parent_comment_id:     string | null;
  thread_root_id:        string;
  body:                  string;
  timestamp_seconds:     number | null;
  duration_seconds:      number | null;
  author_user_id:        string | null;
  author_external_name:  string | null;
  author_external_email: string | null;
  author_avatar_url:     string | null;
  source:                MediaCommentSource;
  frameio_comment_id:    string | null;
  frameio_file_id:       string | null;
  completed:             number;        // 0 | 1
  completed_at:          string | null;
  completed_by_user_id:  string | null;
  created_at:            string;
  updated_at:            string;
  deleted_at:            string | null;
}

/**
 * Input shape for inserting a new comment. The store generates `commentId`
 * (random UUID), `threadRootId` (parent's root if reply, self if top-level),
 * and `createdAt`/`updatedAt` (current ISO timestamp).
 *
 * `parentCommentId` is the LOCAL comment_id of the parent — NOT the Frame.io
 * comment ID. Webhook ingest resolves Frame.io parent_id via the frameio
 * comment-id index first.
 */
export interface MediaCommentInsert {
  projectId:            string;
  assetId:              string;
  assetVersionId:       string;
  parentCommentId?:     string | null;
  body:                 string;
  timestampSeconds?:    number | null;
  durationSeconds?:     number | null;
  authorUserId?:        string | null;
  authorExternalName?:  string | null;
  authorExternalEmail?: string | null;
  authorAvatarUrl?:     string | null;
  source:               MediaCommentSource;
  frameioCommentId?:    string | null;
  frameioFileId?:       string | null;
  completed?:           boolean;
  /** Override the timestamp — used by the backfill script to preserve historical inserted_at values. */
  createdAtOverride?:   string;
}

/** Convert a raw SQLite row into the camelCase model. */
export function rowToMediaComment(row: MediaCommentRow): MediaComment {
  return {
    commentId:           row.comment_id,
    projectId:           row.project_id,
    assetId:             row.asset_id,
    assetVersionId:      row.asset_version_id,
    parentCommentId:     row.parent_comment_id,
    threadRootId:        row.thread_root_id,
    body:                row.body,
    timestampSeconds:    row.timestamp_seconds,
    durationSeconds:     row.duration_seconds,
    authorUserId:        row.author_user_id,
    authorExternalName:  row.author_external_name,
    authorExternalEmail: row.author_external_email,
    authorAvatarUrl:     row.author_avatar_url,
    source:              row.source,
    frameioCommentId:    row.frameio_comment_id,
    frameioFileId:       row.frameio_file_id,
    completed:           row.completed === 1,
    completedAt:         row.completed_at,
    completedByUserId:   row.completed_by_user_id,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
    deletedAt:           row.deleted_at,
  };
}
