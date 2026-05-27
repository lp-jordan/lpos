/**
 * B2 cold-storage object tracking store
 *
 * One row per object that has ever been uploaded to the raw-footage cold-
 * storage B2 bucket. Drives the retention model implemented by
 * B2MediaSyncService — the model itself is documented in the service file,
 * but the rules this store enforces are:
 *
 *   - upsertSeen(key, size)   — file is present in source. Inserts a new row
 *     on first sight (uploaded_at + last_seen_at = now). Subsequent calls
 *     update last_seen_at, refresh size, and CLEAR missing_since if it was
 *     set (so a file that reappeared within retention restarts at zero).
 *
 *   - markMissing(key, asOf)  — file is gone from source. Sets missing_since
 *     to `asOf` only if it isn't already set (preserves the original
 *     disappearance timestamp across multiple nights).
 *
 *   - markDeleted(key)        — B2 object has been removed. Stamps deleted_at;
 *     the row is kept for audit and pruned by pruneAudit() after 90 days.
 *
 *   - listQueuedForDeletion(retainDays) — objects whose missing_since is older
 *     than retainDays AND deleted_at is null. These are the rows the next
 *     sweep should delete from B2.
 *
 *   - listActive()            — all rows where deleted_at IS NULL. Used by
 *     stats queries and the admin "currently in cold storage" view.
 *
 * The store does not touch B2 itself. It is pure SQLite bookkeeping; the
 * service is the only thing that mutates the bucket and reports back.
 */

import { getCoreDb } from './core-db';

export interface ColdStorageObject {
  key:          string;
  size:         number;
  uploadedAt:   string;
  lastSeenAt:   string;
  missingSince: string | null;
  deletedAt:    string | null;
}

interface DbRow {
  key:            string;
  size:           number;
  uploaded_at:    string;
  last_seen_at:   string;
  missing_since:  string | null;
  deleted_at:     string | null;
}

export interface ColdStorageStats {
  activeObjects:    number;
  activeBytes:      number;
  missingObjects:   number;   // missing but inside retention window — not yet deleted
  queuedForDelete:  number;   // missing past retention — next sweep deletes
  deletedHistory:   number;   // deleted_at NOT NULL
}

function rowToObj(row: DbRow): ColdStorageObject {
  return {
    key:          row.key,
    size:         row.size,
    uploadedAt:   row.uploaded_at,
    lastSeenAt:   row.last_seen_at,
    missingSince: row.missing_since,
    deletedAt:    row.deleted_at,
  };
}

/**
 * Record that `key` is present in source at `asOf` with `size` bytes.
 * Creates the row on first sight; otherwise refreshes last_seen_at + size,
 * and clears missing_since so a re-appeared file restarts its retention
 * clock from zero.
 */
export function upsertSeen(key: string, size: number, asOf: string): void {
  getCoreDb()
    .prepare(`
      INSERT INTO b2_cold_storage_objects (key, size, uploaded_at, last_seen_at, missing_since, deleted_at)
      VALUES (?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(key) DO UPDATE SET
        size          = excluded.size,
        last_seen_at  = excluded.last_seen_at,
        missing_since = NULL,
        deleted_at    = NULL
    `)
    .run(key, size, asOf, asOf);
}

/**
 * Mark `key` as missing from source as of `asOf`. No-op if missing_since is
 * already set (we don't reset the clock just because another night confirmed
 * the file is still gone) or if the row already has deleted_at set.
 */
export function markMissing(key: string, asOf: string): void {
  getCoreDb()
    .prepare(`
      UPDATE b2_cold_storage_objects
         SET missing_since = ?
       WHERE key = ?
         AND missing_since IS NULL
         AND deleted_at IS NULL
    `)
    .run(asOf, key);
}

/** Stamp deleted_at on a row after the B2 object has been removed. */
export function markDeleted(key: string, asOf: string): void {
  getCoreDb()
    .prepare(`UPDATE b2_cold_storage_objects SET deleted_at = ? WHERE key = ?`)
    .run(asOf, key);
}

/**
 * Objects whose missing_since is older than retainDays and which haven't
 * been deleted yet. The sweep step deletes these from B2, then calls
 * markDeleted for each.
 */
export function listQueuedForDeletion(retainDays: number, now = new Date()): ColdStorageObject[] {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - retainDays);
  const cutoffIso = cutoff.toISOString();

  const rows = getCoreDb()
    .prepare(`
      SELECT key, size, uploaded_at, last_seen_at, missing_since, deleted_at
        FROM b2_cold_storage_objects
       WHERE deleted_at IS NULL
         AND missing_since IS NOT NULL
         AND missing_since <= ?
       ORDER BY missing_since ASC
    `)
    .all(cutoffIso) as DbRow[];
  return rows.map(rowToObj);
}

/**
 * Currently-missing objects that are still inside the retention window —
 * useful for the admin UI "files pending deletion in N days" panel.
 */
export function listMissingWithinRetention(retainDays: number, now = new Date()): ColdStorageObject[] {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - retainDays);
  const cutoffIso = cutoff.toISOString();

  const rows = getCoreDb()
    .prepare(`
      SELECT key, size, uploaded_at, last_seen_at, missing_since, deleted_at
        FROM b2_cold_storage_objects
       WHERE deleted_at IS NULL
         AND missing_since IS NOT NULL
         AND missing_since > ?
       ORDER BY missing_since ASC
    `)
    .all(cutoffIso) as DbRow[];
  return rows.map(rowToObj);
}

/** All currently-tracked, not-yet-deleted objects. */
export function listActive(): ColdStorageObject[] {
  const rows = getCoreDb()
    .prepare(`
      SELECT key, size, uploaded_at, last_seen_at, missing_since, deleted_at
        FROM b2_cold_storage_objects
       WHERE deleted_at IS NULL
       ORDER BY key
    `)
    .all() as DbRow[];
  return rows.map(rowToObj);
}

/** Stats snapshot for the admin Storage page. */
export function getColdStorageStats(retainDays: number, now = new Date()): ColdStorageStats {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - retainDays);
  const cutoffIso = cutoff.toISOString();

  const db = getCoreDb();
  const active = db.prepare(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(size), 0) AS bytes
      FROM b2_cold_storage_objects
     WHERE deleted_at IS NULL
  `).get() as { cnt: number; bytes: number };

  const missingWithin = db.prepare(`
    SELECT COUNT(*) AS cnt
      FROM b2_cold_storage_objects
     WHERE deleted_at IS NULL
       AND missing_since IS NOT NULL
       AND missing_since > ?
  `).get(cutoffIso) as { cnt: number };

  const queued = db.prepare(`
    SELECT COUNT(*) AS cnt
      FROM b2_cold_storage_objects
     WHERE deleted_at IS NULL
       AND missing_since IS NOT NULL
       AND missing_since <= ?
  `).get(cutoffIso) as { cnt: number };

  const history = db.prepare(`
    SELECT COUNT(*) AS cnt
      FROM b2_cold_storage_objects
     WHERE deleted_at IS NOT NULL
  `).get() as { cnt: number };

  return {
    activeObjects:   active.cnt,
    activeBytes:     active.bytes,
    missingObjects:  missingWithin.cnt,
    queuedForDelete: queued.cnt,
    deletedHistory:  history.cnt,
  };
}

/**
 * Remove rows where deleted_at is older than 90 days. Audit-history pruning
 * keeps the table from growing forever. Called once per runSync().
 */
export function pruneAudit(now = new Date()): number {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 90);
  const res = getCoreDb()
    .prepare(`DELETE FROM b2_cold_storage_objects WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
    .run(cutoff.toISOString());
  return Number(res.changes ?? 0);
}

/**
 * Bulk fetch a key→row map for fast reconciliation during sync. Returns only
 * non-deleted rows.
 */
export function getActiveKeyMap(): Map<string, ColdStorageObject> {
  const rows = listActive();
  const map = new Map<string, ColdStorageObject>();
  for (const r of rows) map.set(r.key, r);
  return map;
}
