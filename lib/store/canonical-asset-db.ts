import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'lpos-canonical-assets.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_canonical_asset_db: DatabaseSync | undefined;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS assets (
      asset_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      client_code TEXT,
      display_label TEXT,
      current_display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      source_system TEXT NOT NULL DEFAULT 'lpos',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      migration_source TEXT,
      migrated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_assets_project_id ON assets(project_id, created_at);

    CREATE TABLE IF NOT EXISTS editorial_links (
      editorial_link_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
      resolve_project_name TEXT,
      resolve_project_id TEXT,
      resolve_timeline_name TEXT,
      resolve_timeline_unique_id TEXT,
      editpanel_task_id TEXT,
      registered_by TEXT,
      registered_at TEXT,
      writeback_status TEXT NOT NULL DEFAULT 'not_attempted',
      writeback_error TEXT,
      last_confirmed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asset_versions (
      asset_version_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      version_label TEXT,
      ingest_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      exported_at TEXT,
      ingested_at TEXT NOT NULL,
      export_preset TEXT,
      edit_label_at_export TEXT,
      source_event_id TEXT,
      replaced_by_version_id TEXT,
      supersedes_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(asset_id, version_number)
    );

    CREATE INDEX IF NOT EXISTS idx_asset_versions_asset_id ON asset_versions(asset_id, version_number DESC);

    CREATE TABLE IF NOT EXISTS media_files (
      media_file_id TEXT PRIMARY KEY,
      asset_version_id TEXT NOT NULL REFERENCES asset_versions(asset_version_id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'primary',
      source_path TEXT,
      managed_path TEXT,
      storage_class TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      managed_filename TEXT,
      mime_type TEXT,
      file_size_bytes INTEGER,
      content_hash TEXT,
      source_modified_at TEXT,
      copied_to_managed_at TEXT,
      is_source_available INTEGER NOT NULL DEFAULT 0,
      is_managed_available INTEGER NOT NULL DEFAULT 0,
      displacement_status TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_files_asset_version_id ON media_files(asset_version_id);

    CREATE TABLE IF NOT EXISTS distribution_records (
      distribution_record_id TEXT PRIMARY KEY,
      asset_version_id TEXT NOT NULL REFERENCES asset_versions(asset_version_id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_status TEXT NOT NULL,
      provider_asset_id TEXT,
      provider_parent_id TEXT,
      attempt_number INTEGER NOT NULL DEFAULT 1,
      published_at TEXT,
      ready_at TEXT,
      last_error TEXT,
      playback_url TEXT,
      review_url TEXT,
      thumbnail_url TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_distribution_records_asset_version ON distribution_records(asset_version_id, provider, attempt_number DESC);

    CREATE TABLE IF NOT EXISTS distribution_attachments (
      distribution_attachment_id TEXT PRIMARY KEY,
      distribution_record_id TEXT NOT NULL REFERENCES distribution_records(distribution_record_id) ON DELETE CASCADE,
      attachment_type TEXT NOT NULL,
      external_parent_id TEXT NOT NULL,
      external_child_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ingest_exceptions (
      ingest_exception_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      asset_id TEXT,
      asset_version_id TEXT,
      severity TEXT NOT NULL,
      exception_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT,
      source_path TEXT,
      managed_path TEXT,
      detected_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution_status TEXT,
      resolved_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transcription_jobs (
      transcription_job_id TEXT PRIMARY KEY,
      asset_version_id TEXT NOT NULL REFERENCES asset_versions(asset_version_id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      job_id TEXT,
      provider TEXT,
      completed_at TEXT,
      last_error TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transcription_jobs_asset_version ON transcription_jobs(asset_version_id, updated_at DESC);
  `);
}

export function getCanonicalAssetDb(): DatabaseSync {
  if (globalThis.__lpos_canonical_asset_db) return globalThis.__lpos_canonical_asset_db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  globalThis.__lpos_canonical_asset_db = db;
  return db;
}

export function getCanonicalAssetDbPath(): string {
  return DB_PATH;
}
