import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'lpos-core.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_core_db: DatabaseSync | undefined;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA foreign_keys = ON`);
  db.exec(`PRAGMA journal_mode = WAL`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      google_sub    TEXT NOT NULL UNIQUE,
      email         TEXT NOT NULL,
      name          TEXT NOT NULL,
      avatar_url    TEXT,
      created_at    TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);
    CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);

    CREATE TABLE IF NOT EXISTS projects (
      project_id  TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      client_name TEXT NOT NULL,
      phase       TEXT NOT NULL DEFAULT 'pre_production',
      sub_phase   TEXT NOT NULL DEFAULT 'discovery',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      archived    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_projects_client   ON projects(client_name);
    CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived);

    CREATE TABLE IF NOT EXISTS tasks (
      task_id      TEXT PRIMARY KEY,
      description  TEXT NOT NULL,
      project_id   TEXT NOT NULL,
      client_name  TEXT,
      priority     TEXT NOT NULL DEFAULT 'medium',
      status       TEXT NOT NULL DEFAULT 'not_started',
      notes        TEXT,
      created_by   TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project    ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);

    CREATE TABLE IF NOT EXISTS task_assignees (
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (task_id, user_id),
      FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);

    CREATE TABLE IF NOT EXISTS wishes (
      wish_id           TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      description       TEXT,
      submitted_by      TEXT NOT NULL,
      submitted_by_name TEXT NOT NULL,
      completed         INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      completed_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wishes_submitted_by ON wishes(submitted_by);
    CREATE INDEX IF NOT EXISTS idx_wishes_completed    ON wishes(completed);

    CREATE TABLE IF NOT EXISTS client_owners (
      client_name TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS share_assets (
      project_id TEXT NOT NULL,
      share_id   TEXT NOT NULL,
      file_ids   TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (project_id, share_id)
    );

    CREATE TABLE IF NOT EXISTS asset_share_links (
      project_id TEXT NOT NULL,
      asset_id   TEXT NOT NULL,
      share_id   TEXT NOT NULL,
      share_url  TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id, share_id)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_share_links_asset ON asset_share_links(project_id, asset_id);

    CREATE TABLE IF NOT EXISTS task_comments (
      comment_id TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      author_id  TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task   ON task_comments(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_comments_author ON task_comments(author_id);

    CREATE TABLE IF NOT EXISTS comment_mentions (
      comment_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      PRIMARY KEY (comment_id, user_id),
      FOREIGN KEY (comment_id) REFERENCES task_comments(comment_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_notifications (
      notif_id     TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      type         TEXT NOT NULL,
      task_id      TEXT NOT NULL,
      task_title   TEXT NOT NULL,
      from_user_id TEXT,
      from_name    TEXT,
      read         INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_notifs_user_read ON task_notifications(user_id, read);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      user_id    TEXT NOT NULL,
      endpoint   TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, endpoint)
    );

    CREATE TABLE IF NOT EXISTS admins (
      email TEXT PRIMARY KEY
    );
  `);
}

function runMigrations(db: DatabaseSync): void {
  // v2: phase column on tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'pre_production'`);
    // Backfill: keep 'done', reset legacy statuses to the pre_production default
    db.exec(`UPDATE tasks SET status = 'onboarding' WHERE status NOT IN ('done')`);
  } catch {
    // Column already exists — migration already ran
  }

  // v3: slack_email override on users
  try {
    db.exec(`ALTER TABLE users ADD COLUMN slack_email TEXT`);
  } catch {
    // Column already exists — migration already ran
  }
}

export function getCoreDb(): DatabaseSync {
  if (globalThis.__lpos_core_db) return globalThis.__lpos_core_db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  runMigrations(db);
  globalThis.__lpos_core_db = db;
  return db;
}

export function withTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
