/**
 * B2 media sync configuration store
 *
 * Operational knobs for the nightly B2MediaSyncService that the admin tunes
 * from Settings → B2 Media Sync. Credentials stay in Doppler env vars
 * (B2_MEDIA_ENDPOINT/KEY_ID/APPLICATION_KEY/BUCKET) — only the knobs live here.
 *
 * Single-row table (config_id = 1). Get always returns a fully-populated
 * row, falling back to defaults if the row doesn't exist yet.
 */

import { getCoreDb } from './core-db';

export interface B2SyncConfig {
  syncDirs:   string[];   // absolute paths to walk + upload
  retainDays: number;     // delete bucket objects older than this
  syncHour:   number;     // 0–23, wall-clock hour for the daily run
  updatedAt:  string;     // ISO 8601, last write
}

interface DbRow {
  sync_dirs:   string;
  retain_days: number;
  sync_hour:   number;
  updated_at:  string;
}

const DEFAULTS: B2SyncConfig = {
  syncDirs:   [],
  retainDays: 30,
  syncHour:   2,
  updatedAt:  '1970-01-01T00:00:00.000Z',
};

function parseDirs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
    }
  } catch { /* fall through */ }
  return [];
}

function rowToConfig(row: DbRow): B2SyncConfig {
  return {
    syncDirs:   parseDirs(row.sync_dirs),
    retainDays: row.retain_days,
    syncHour:   row.sync_hour,
    updatedAt:  row.updated_at,
  };
}

export function getB2SyncConfig(): B2SyncConfig {
  const row = getCoreDb()
    .prepare(`SELECT sync_dirs, retain_days, sync_hour, updated_at FROM b2_sync_config WHERE config_id = 1`)
    .get() as DbRow | undefined;
  if (!row) return { ...DEFAULTS };
  return rowToConfig(row);
}

/**
 * Partial update. Any field left undefined keeps its current value.
 * Returns the new config row.
 */
export function setB2SyncConfig(patch: Partial<B2SyncConfig>): B2SyncConfig {
  const current = getB2SyncConfig();
  const next: B2SyncConfig = {
    syncDirs:   patch.syncDirs   !== undefined ? sanitizeDirs(patch.syncDirs)         : current.syncDirs,
    retainDays: patch.retainDays !== undefined ? clampInt(patch.retainDays, 1, 3650)  : current.retainDays,
    syncHour:   patch.syncHour   !== undefined ? clampInt(patch.syncHour,   0, 23)    : current.syncHour,
    updatedAt:  new Date().toISOString(),
  };

  getCoreDb()
    .prepare(`
      INSERT INTO b2_sync_config (config_id, sync_dirs, retain_days, sync_hour, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(config_id) DO UPDATE SET
        sync_dirs   = excluded.sync_dirs,
        retain_days = excluded.retain_days,
        sync_hour   = excluded.sync_hour,
        updated_at  = excluded.updated_at
    `)
    .run(JSON.stringify(next.syncDirs), next.retainDays, next.syncHour, next.updatedAt);

  return next;
}

function sanitizeDirs(raw: string[]): string[] {
  return raw
    .map((d) => (typeof d === 'string' ? d.trim() : ''))
    .filter((d) => d.length > 0);
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
