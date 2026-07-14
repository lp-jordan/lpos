import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'lpos-activity.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_activity_db: DatabaseSync | undefined;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS activity_events (
      event_id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      lifecycle_phase TEXT NOT NULL,
      visibility TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_service TEXT,
      source_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      actor_display TEXT,
      client_id TEXT,
      project_id TEXT,
      asset_id TEXT,
      job_id TEXT,
      service_id TEXT,
      correlation_id TEXT,
      causation_event_id TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      search_text TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      impact_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_activity_events_project_id
      ON activity_events(project_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_client_id
      ON activity_events(client_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_actor_id
      ON activity_events(actor_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_asset_id
      ON activity_events(asset_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_job_id
      ON activity_events(job_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_event_type
      ON activity_events(event_type, occurred_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_dedupe_key
      ON activity_events(dedupe_key)
      WHERE dedupe_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS project_current_state (
      project_id TEXT PRIMARY KEY,
      client_id TEXT,
      current_status TEXT NOT NULL,
      last_activity_at TEXT,
      last_user_activity_at TEXT,
      last_user_actor_id TEXT,
      last_blocked_at TEXT,
      last_completed_at TEXT,
      open_issue_count INTEGER NOT NULL DEFAULT 0,
      pending_notification_count INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_latest_status (
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      project_id TEXT,
      client_id TEXT,
      status TEXT NOT NULL,
      status_reason TEXT,
      last_event_id TEXT NOT NULL,
      last_event_type TEXT NOT NULL,
      last_occurred_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (entity_kind, entity_id)
    );

    CREATE TABLE IF NOT EXISTS notification_candidates (
      notification_candidate_id TEXT PRIMARY KEY,
      project_id TEXT,
      client_id TEXT,
      event_id TEXT NOT NULL,
      notification_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      recipient_scope_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_candidates_dedupe_key
      ON notification_candidates(dedupe_key)
      WHERE dedupe_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS activity_summary_windows (
      summary_window_id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      summary_kind TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_summary_windows_scope_window
      ON activity_summary_windows(scope_kind, scope_id, window_start, window_end, summary_kind);

    -- Daily Catch-Up: one cached, fully-assembled payload per past calendar day.
    -- Yesterday's data is static, so the whole payload (including the AI headline)
    -- caches safely — everyone who opens the drawer reads the same row, and the
    -- headline is generated exactly once per day. Keyed by YYYY-MM-DD (Eastern).
    CREATE TABLE IF NOT EXISTS catchup_cache (
      date TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );
  `);
}

export function getActivityDb(): DatabaseSync {
  if (globalThis.__lpos_activity_db) return globalThis.__lpos_activity_db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  globalThis.__lpos_activity_db = db;
  return db;
}

export function getActivityDbPath(): string {
  return DB_PATH;
}

export function resetActivityDbForTests(): void {
  globalThis.__lpos_activity_db?.close();
  globalThis.__lpos_activity_db = undefined;
}

// ── Daily Catch-Up cache ───────────────────────────────────────────────────────

/** Read a cached catch-up payload for a past day; null on miss. */
export function getCatchupCache(date: string): string | null {
  const row = getActivityDb()
    .prepare('SELECT payload_json FROM catchup_cache WHERE date = ?')
    .get(date) as { payload_json: string } | undefined;
  return row?.payload_json ?? null;
}

/** Store (or replace) the cached catch-up payload for a day. */
export function setCatchupCache(date: string, payloadJson: string): void {
  getActivityDb()
    .prepare(
      `INSERT INTO catchup_cache (date, payload_json, generated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         payload_json = excluded.payload_json,
         generated_at = excluded.generated_at`,
    )
    .run(date, payloadJson, new Date().toISOString());
}

/**
 * Returns the most-recent `occurred_at` per project for the given project IDs.
 * Drives the client-list "Most Recent Activity" sort. Cheap — uses the existing
 * `idx_activity_events_project_id (project_id, occurred_at DESC)` index, so the
 * MAX is effectively a single index seek per project.
 *
 * Projects with zero events recorded simply won't appear in the map; callers
 * should fall back to `projects.updated_at` for those.
 */
export function getLatestActivityByProject(projectIds: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (projectIds.length === 0) return result;
  const placeholders = projectIds.map(() => '?').join(',');
  const rows = getActivityDb()
    .prepare(
      `SELECT project_id, MAX(occurred_at) AS latest
       FROM activity_events
       WHERE project_id IN (${placeholders})
       GROUP BY project_id`,
    )
    .all(...projectIds) as Array<{ project_id: string; latest: string | null }>;
  for (const row of rows) {
    if (row.project_id && row.latest) result.set(row.project_id, row.latest);
  }
  return result;
}

/**
 * Returns the most-recent comment `occurred_at` per asset for the given project.
 * Drives the MediaTab "Latest comments" sort. Restricted to Frame.io comment
 * event types (top-level and replies) so non-comment activity doesn't bleed in.
 * Uses the `idx_activity_events_asset_id (asset_id, occurred_at DESC)` index;
 * the `event_type` filter and `project_id` predicate are evaluated against the
 * narrow per-asset rowset.
 *
 * Assets with zero comment events simply won't appear in the map; callers
 * should treat them as "no comments" and sort them last.
 */
export function getLatestCommentByAssetForProject(projectId: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!projectId) return result;
  const rows = getActivityDb()
    .prepare(
      `SELECT asset_id, MAX(occurred_at) AS latest
       FROM activity_events
       WHERE project_id = ?
         AND asset_id IS NOT NULL
         AND event_type IN ('frameio.comment.created', 'frameio.comment.reply.created')
       GROUP BY asset_id`,
    )
    .all(projectId) as Array<{ asset_id: string | null; latest: string | null }>;
  for (const row of rows) {
    if (row.asset_id && row.latest) result.set(row.asset_id, row.latest);
  }
  return result;
}
