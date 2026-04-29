import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'lpos-ingest-queue.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_ingest_queue_db: DatabaseSync | undefined;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA foreign_keys = ON`);
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA busy_timeout = 5000`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_jobs (
      job_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      detail TEXT,
      temp_path TEXT,
      stable_path TEXT,
      queued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status    ON ingest_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_ingest_jobs_project   ON ingest_jobs(project_id, queued_at);
    CREATE INDEX IF NOT EXISTS idx_ingest_jobs_completed ON ingest_jobs(completed_at);
  `);

  // Lightweight publish & promotion job records for stale-sweep on boot
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_job_records (
      job_id       TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      asset_id     TEXT NOT NULL,
      filename     TEXT NOT NULL,
      provider     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'in_progress',
      queued_at    TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS promotion_job_records (
      job_id       TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      filename     TEXT NOT NULL,
      file_key     TEXT NOT NULL,
      destination  TEXT NOT NULL,
      storage_type TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'in_progress',
      queued_at    TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      completed_at TEXT
    );
  `);

  // Migration: add batch_id for stale-sweep batch awareness (safe to run repeatedly)
  try {
    db.exec(`ALTER TABLE ingest_jobs ADD COLUMN batch_id TEXT`);
  } catch {
    // Column already exists
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ingest_jobs_batch ON ingest_jobs(batch_id)`);

  // Migration: add file_size so IngestTray can show size during queued/ingesting phases
  try {
    db.exec(`ALTER TABLE ingest_jobs ADD COLUMN file_size INTEGER`);
  } catch {
    // Column already exists
  }

  // Chunked upload sessions — one row per in-progress chunked upload.
  // Persisted so uploads can be resumed after server restart or browser reload.
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_sessions (
      upload_id          TEXT PRIMARY KEY,
      job_id             TEXT NOT NULL,
      project_id         TEXT NOT NULL,
      filename           TEXT NOT NULL,
      file_size          INTEGER NOT NULL,
      bytes_received     INTEGER NOT NULL DEFAULT 0,
      temp_path          TEXT NOT NULL,
      replace_asset_id   TEXT,
      status             TEXT NOT NULL DEFAULT 'uploading',
      version_meta_json  TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES ingest_jobs(job_id)
    );

    CREATE INDEX IF NOT EXISTS idx_upload_sessions_job     ON upload_sessions(job_id);
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_project ON upload_sessions(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_status  ON upload_sessions(status, updated_at);
  `);
}

export function getIngestQueueDb(): DatabaseSync {
  if (globalThis.__lpos_ingest_queue_db) return globalThis.__lpos_ingest_queue_db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  globalThis.__lpos_ingest_queue_db = db;
  return db;
}
