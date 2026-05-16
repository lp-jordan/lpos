import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'lpos-photos.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_photo_db: DatabaseSync | undefined;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA busy_timeout = 5000`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS photos (
      photo_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      capture_date TEXT,
      uploaded_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      edited INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_photos_project_uploaded ON photos(project_id, uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_photos_project_capture  ON photos(project_id, capture_date DESC);
    CREATE INDEX IF NOT EXISTS idx_photos_project_name     ON photos(project_id, original_filename);
    CREATE INDEX IF NOT EXISTS idx_photos_project_size     ON photos(project_id, file_size);
    CREATE INDEX IF NOT EXISTS idx_photos_project_edited   ON photos(project_id, edited);
  `);
}

export function getPhotoDb(): DatabaseSync {
  if (globalThis.__lpos_photo_db) return globalThis.__lpos_photo_db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  globalThis.__lpos_photo_db = db;
  return db;
}

export function getPhotoDbPath(): string {
  return DB_PATH;
}
