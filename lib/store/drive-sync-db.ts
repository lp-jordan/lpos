/**
 * Drive Sync Database
 *
 * SQLite store for Google Drive ↔ LPOS file mappings and watch channel state.
 * File: data/lpos-drive-sync.sqlite
 *
 * Tables:
 *   drive_assets        — Drive file ID ↔ LPOS entity mapping
 *   drive_watch_channels — Active push notification channel state (for renewal)
 */

import fs   from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH  = path.join(DATA_DIR, 'lpos-drive-sync.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_drive_sync_db: DatabaseSync | undefined;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS drive_assets (
      id             TEXT PRIMARY KEY,
      entity_type    TEXT NOT NULL,
      entity_id      TEXT NOT NULL,
      project_id     TEXT NOT NULL,
      drive_file_id  TEXT NOT NULL UNIQUE,
      drive_folder_id TEXT,
      name           TEXT NOT NULL,
      mime_type      TEXT,
      web_view_link  TEXT,
      synced_at      TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
  `);

  // Safe migrations — ALTER TABLE is idempotent via try/catch
  const migrations = [
    `ALTER TABLE drive_assets ADD COLUMN is_folder INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE drive_assets ADD COLUMN parent_drive_id TEXT`,
    `ALTER TABLE drive_assets ADD COLUMN local_path TEXT`,
    `ALTER TABLE drive_assets ADD COLUMN file_size INTEGER`,
    `ALTER TABLE drive_assets ADD COLUMN modified_at TEXT`,
    `ALTER TABLE drive_assets ADD COLUMN source TEXT NOT NULL DEFAULT 'drive'`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  db.exec(`

    CREATE INDEX IF NOT EXISTS idx_drive_assets_entity
      ON drive_assets(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_drive_assets_project
      ON drive_assets(project_id);
    CREATE INDEX IF NOT EXISTS idx_drive_assets_drive_file
      ON drive_assets(drive_file_id);

    CREATE TABLE IF NOT EXISTS drive_watch_channels (
      channel_id   TEXT PRIMARY KEY,
      resource_id  TEXT NOT NULL,
      drive_id     TEXT NOT NULL,
      page_token   TEXT,
      expires_at   TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drive_orphaned_folders (
      id              TEXT PRIMARY KEY,
      drive_file_id   TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      client_name     TEXT NOT NULL,
      parent_drive_id TEXT NOT NULL,
      detected_at     TEXT NOT NULL,
      resolved_at     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orphaned_client_name
      ON drive_orphaned_folders(client_name, name);
  `);
}

export function getDriveSyncDb(): DatabaseSync {
  if (globalThis.__lpos_drive_sync_db) return globalThis.__lpos_drive_sync_db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  globalThis.__lpos_drive_sync_db = db;
  return db;
}

// ── drive_assets ──────────────────────────────────────────────────────────────

export type DriveEntityType = 'script' | 'transcript' | 'media' | 'asset';
export type DriveAssetSource = 'drive' | 'local';

export interface DriveAsset {
  id:            string;
  entityType:    DriveEntityType;
  entityId:      string;
  projectId:     string;
  driveFileId:   string;
  driveFolderId: string | null;
  name:          string;
  mimeType:      string | null;
  webViewLink:   string | null;
  syncedAt:      string;
  createdAt:     string;
  // filesystem extension fields
  isFolder:      boolean;
  parentDriveId: string | null;
  localPath:     string | null;
  fileSize:      number | null;
  modifiedAt:    string | null;
  source:        DriveAssetSource;
}

export interface UpsertDriveAssetInput {
  entityType:    DriveEntityType;
  entityId:      string;
  projectId:     string;
  driveFileId:   string;
  driveFolderId?: string;
  name:          string;
  mimeType?:     string;
  webViewLink?:  string;
  isFolder?:     boolean;
  parentDriveId?: string;
  localPath?:    string;
  fileSize?:     number;
  modifiedAt?:   string;
  source?:       DriveAssetSource;
}

export function upsertDriveAsset(input: UpsertDriveAssetInput): DriveAsset {
  const db  = getDriveSyncDb();
  const now = new Date().toISOString();

  // Check if record exists (by driveFileId)
  const existing = db.prepare(
    'SELECT id FROM drive_assets WHERE drive_file_id = ?'
  ).get(input.driveFileId) as { id: string } | undefined;

  const id = existing?.id ?? randomUUID();

  db.prepare(`
    INSERT INTO drive_assets
      (id, entity_type, entity_id, project_id, drive_file_id, drive_folder_id,
       name, mime_type, web_view_link, synced_at, created_at,
       is_folder, parent_drive_id, local_path, file_size, modified_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(drive_file_id) DO UPDATE SET
      entity_type     = excluded.entity_type,
      entity_id       = excluded.entity_id,
      project_id      = excluded.project_id,
      drive_folder_id = excluded.drive_folder_id,
      name            = excluded.name,
      mime_type       = excluded.mime_type,
      web_view_link   = excluded.web_view_link,
      synced_at       = excluded.synced_at,
      is_folder       = excluded.is_folder,
      parent_drive_id = excluded.parent_drive_id,
      local_path      = excluded.local_path,
      file_size       = excluded.file_size,
      modified_at     = excluded.modified_at,
      source          = excluded.source
  `).run(
    id,
    input.entityType,
    input.entityId,
    input.projectId,
    input.driveFileId,
    input.driveFolderId ?? null,
    input.name,
    input.mimeType ?? null,
    input.webViewLink ?? null,
    now,
    existing ? now : now, // created_at — always use now for simplicity in upsert
    input.isFolder ? 1 : 0,
    input.parentDriveId ?? null,
    input.localPath ?? null,
    input.fileSize ?? null,
    input.modifiedAt ?? null,
    input.source ?? 'drive',
  );

  return getDriveAssetByFileId(input.driveFileId)!;
}

export function getDriveAssetByEntityId(
  entityType: DriveEntityType,
  entityId:   string,
): DriveAsset | null {
  const db  = getDriveSyncDb();
  const row = db.prepare(
    'SELECT * FROM drive_assets WHERE entity_type = ? AND entity_id = ? LIMIT 1'
  ).get(entityType, entityId) as Record<string, unknown> | undefined;
  return row ? rowToAsset(row) : null;
}

export function getDriveAssetByFileId(driveFileId: string): DriveAsset | null {
  const db  = getDriveSyncDb();
  const row = db.prepare(
    'SELECT * FROM drive_assets WHERE drive_file_id = ? LIMIT 1'
  ).get(driveFileId) as Record<string, unknown> | undefined;
  return row ? rowToAsset(row) : null;
}

export function getDriveAssetsByProject(projectId: string): DriveAsset[] {
  const db   = getDriveSyncDb();
  const rows = db.prepare(
    'SELECT * FROM drive_assets WHERE project_id = ? ORDER BY synced_at DESC'
  ).all(projectId) as Record<string, unknown>[];
  return rows.map(rowToAsset);
}

function rowToAsset(row: Record<string, unknown>): DriveAsset {
  return {
    id:            row.id as string,
    entityType:    row.entity_type as DriveEntityType,
    entityId:      row.entity_id as string,
    projectId:     row.project_id as string,
    driveFileId:   row.drive_file_id as string,
    driveFolderId: row.drive_folder_id as string | null,
    name:          row.name as string,
    mimeType:      row.mime_type as string | null,
    webViewLink:   row.web_view_link as string | null,
    syncedAt:      row.synced_at as string,
    createdAt:     row.created_at as string,
    isFolder:      !!(row.is_folder as number),
    parentDriveId: row.parent_drive_id as string | null,
    localPath:     row.local_path as string | null,
    fileSize:      row.file_size as number | null,
    modifiedAt:    row.modified_at as string | null,
    source:        (row.source as DriveAssetSource | null) ?? 'drive',
  };
}

export function getDriveAssetsByParent(parentDriveId: string): DriveAsset[] {
  const rows = getDriveSyncDb().prepare(
    'SELECT * FROM drive_assets WHERE parent_drive_id = ? ORDER BY is_folder DESC, name ASC'
  ).all(parentDriveId) as Record<string, unknown>[];
  return rows.map(rowToAsset);
}

export function getDriveFolderByDriveId(driveFileId: string): DriveAsset | null {
  const row = getDriveSyncDb().prepare(
    'SELECT * FROM drive_assets WHERE drive_file_id = ? AND is_folder = 1 LIMIT 1'
  ).get(driveFileId) as Record<string, unknown> | undefined;
  return row ? rowToAsset(row) : null;
}

export function renameDriveAsset(entityId: string, newName: string): DriveAsset | null {
  const db  = getDriveSyncDb();
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE drive_assets SET name = ?, synced_at = ? WHERE entity_id = ?'
  ).run(newName, now, entityId);
  const row = db.prepare(
    'SELECT * FROM drive_assets WHERE entity_id = ? LIMIT 1'
  ).get(entityId) as Record<string, unknown> | undefined;
  return row ? rowToAsset(row) : null;
}

export function deleteDriveAssetByEntityId(entityId: string): void {
  getDriveSyncDb()
    .prepare('DELETE FROM drive_assets WHERE entity_id = ?')
    .run(entityId);
}

// ── drive_watch_channels ──────────────────────────────────────────────────────

export interface DriveWatchChannel {
  channelId:  string;
  resourceId: string;
  driveId:    string;
  pageToken:  string | null;
  expiresAt:  string;
  createdAt:  string;
}

export function upsertChannel(input: {
  channelId:  string;
  resourceId: string;
  driveId:    string;
  pageToken?: string;
  expiresAt:  string;
}): void {
  const db  = getDriveSyncDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO drive_watch_channels
      (channel_id, resource_id, drive_id, page_token, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      resource_id = excluded.resource_id,
      page_token  = excluded.page_token,
      expires_at  = excluded.expires_at
  `).run(
    input.channelId,
    input.resourceId,
    input.driveId,
    input.pageToken ?? null,
    input.expiresAt,
    now,
  );
}

export function getActiveChannel(driveId: string): DriveWatchChannel | null {
  const db  = getDriveSyncDb();
  const row = db.prepare(
    'SELECT * FROM drive_watch_channels WHERE drive_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(driveId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    channelId:  row.channel_id as string,
    resourceId: row.resource_id as string,
    driveId:    row.drive_id as string,
    pageToken:  row.page_token as string | null,
    expiresAt:  row.expires_at as string,
    createdAt:  row.created_at as string,
  };
}

export function updateChannelPageToken(channelId: string, pageToken: string): void {
  getDriveSyncDb()
    .prepare('UPDATE drive_watch_channels SET page_token = ? WHERE channel_id = ?')
    .run(pageToken, channelId);
}

export function deleteChannel(channelId: string): void {
  getDriveSyncDb()
    .prepare('DELETE FROM drive_watch_channels WHERE channel_id = ?')
    .run(channelId);
}

// ── drive_orphaned_folders ────────────────────────────────────────────────────

export interface DriveOrphanedFolder {
  id:            string;
  driveFileId:   string;
  name:          string;
  clientName:    string;
  parentDriveId: string;
  detectedAt:    string;
  resolvedAt:    string | null;
}

export function upsertOrphanedFolder(input: {
  driveFileId:   string;
  name:          string;
  clientName:    string;
  parentDriveId: string;
}): void {
  const db  = getDriveSyncDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO drive_orphaned_folders
      (id, drive_file_id, name, client_name, parent_drive_id, detected_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(drive_file_id) DO NOTHING
  `).run(randomUUID(), input.driveFileId, input.name, input.clientName, input.parentDriveId, now);
}

export function getOrphanedFolderByDriveId(driveFileId: string): DriveOrphanedFolder | undefined {
  const row = getDriveSyncDb().prepare(
    'SELECT * FROM drive_orphaned_folders WHERE drive_file_id = ? LIMIT 1'
  ).get(driveFileId) as Record<string, unknown> | undefined;
  return row ? rowToOrphaned(row) : undefined;
}

export function getOrphanedFolderByClientProject(
  clientName: string,
  name:       string,
): DriveOrphanedFolder | undefined {
  const row = getDriveSyncDb().prepare(
    'SELECT * FROM drive_orphaned_folders WHERE client_name = ? AND name = ? AND resolved_at IS NULL LIMIT 1'
  ).get(clientName, name) as Record<string, unknown> | undefined;
  return row ? rowToOrphaned(row) : undefined;
}

export function markOrphanedFolderResolved(driveFileId: string): void {
  getDriveSyncDb().prepare(
    'UPDATE drive_orphaned_folders SET resolved_at = ? WHERE drive_file_id = ?'
  ).run(new Date().toISOString(), driveFileId);
}

function rowToOrphaned(row: Record<string, unknown>): DriveOrphanedFolder {
  return {
    id:            row.id as string,
    driveFileId:   row.drive_file_id as string,
    name:          row.name as string,
    clientName:    row.client_name as string,
    parentDriveId: row.parent_drive_id as string,
    detectedAt:    row.detected_at as string,
    resolvedAt:    row.resolved_at as string | null,
  };
}
