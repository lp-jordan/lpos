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

  // Migration: add batch_id for stale-sweep batch awareness (safe to run repeatedly)
  try {
    db.exec(`ALTER TABLE ingest_jobs ADD COLUMN batch_id TEXT`);
  } catch {
    // Column already exists
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ingest_jobs_batch ON ingest_jobs(batch_id)`);
}

export function getIngestQueueDb(): DatabaseSync {
  if (globalThis.__lpos_ingest_queue_db) return globalThis.__lpos_ingest_queue_db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  globalThis.__lpos_ingest_queue_db = db;
  return db;
}
