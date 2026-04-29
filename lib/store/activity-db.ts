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
