import { getCanonicalAssetDb } from '@/lib/store/canonical-asset-db';

export interface CloudflareOrphan {
  uid: string;
  assetIdWhenOrphaned: string | null;
  projectIdWhenOrphaned: string | null;
  nameWhenOrphaned: string | null;
  /** Why this UID was flagged: 'delete_failed' (post-publish cleanup couldn't reach CF) or 'reconciler' (periodic sweep). */
  reason: 'delete_failed' | 'reconciler';
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
  lastError: string | null;
  purgedAt: string | null;
}

type Row = {
  uid: string;
  asset_id_when_orphaned: string | null;
  project_id_when_orphaned: string | null;
  name_when_orphaned: string | null;
  reason: 'delete_failed' | 'reconciler';
  first_seen_at: string;
  last_seen_at: string;
  attempts: number;
  last_error: string | null;
  purged_at: string | null;
};

function rowToOrphan(row: Row): CloudflareOrphan {
  return {
    uid: row.uid,
    assetIdWhenOrphaned: row.asset_id_when_orphaned,
    projectIdWhenOrphaned: row.project_id_when_orphaned,
    nameWhenOrphaned: row.name_when_orphaned,
    reason: row.reason,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    attempts: row.attempts,
    lastError: row.last_error,
    purgedAt: row.purged_at,
  };
}

export interface RecordOrphanInput {
  uid: string;
  assetId?: string | null;
  projectId?: string | null;
  name?: string | null;
  reason: CloudflareOrphan['reason'];
  attempts?: number;
  lastError?: string | null;
}

/**
 * Upsert an orphan record. If the UID is already known, refresh last_seen_at and increment
 * attempts. Context fields (asset_id_when_orphaned, project_id_when_orphaned, name_when_orphaned)
 * are filled in on conflict only if the existing row has NULL — so later reconciler passes
 * back-enrich rows that were recorded before we had a way to resolve them.
 */
export function recordOrphan(input: RecordOrphanInput): void {
  const now = new Date().toISOString();
  const db = getCanonicalAssetDb();
  db.prepare(`
    INSERT INTO cloudflare_orphans (
      uid, asset_id_when_orphaned, project_id_when_orphaned, name_when_orphaned, reason,
      first_seen_at, last_seen_at, attempts, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET
      last_seen_at             = excluded.last_seen_at,
      attempts                 = cloudflare_orphans.attempts + excluded.attempts,
      last_error               = excluded.last_error,
      reason                   = CASE WHEN cloudflare_orphans.reason = 'delete_failed' THEN cloudflare_orphans.reason ELSE excluded.reason END,
      asset_id_when_orphaned   = COALESCE(cloudflare_orphans.asset_id_when_orphaned,   excluded.asset_id_when_orphaned),
      project_id_when_orphaned = COALESCE(cloudflare_orphans.project_id_when_orphaned, excluded.project_id_when_orphaned),
      name_when_orphaned       = COALESCE(cloudflare_orphans.name_when_orphaned,       excluded.name_when_orphaned),
      purged_at                = NULL
  `).run(
    input.uid,
    input.assetId ?? null,
    input.projectId ?? null,
    input.name ?? null,
    input.reason,
    now,
    now,
    input.attempts ?? 1,
    input.lastError ?? null,
  );
}

/**
 * Refresh last_seen_at for a known orphan and opportunistically fill in context fields
 * that are still NULL. Used by the reconciler's "already-known orphan" path so a UID
 * recorded before we had context-resolution gets back-enriched on the next sweep.
 */
export function refreshOrphanContext(
  uid: string,
  context: { assetId: string | null; projectId: string | null; name: string | null },
): void {
  const now = new Date().toISOString();
  getCanonicalAssetDb().prepare(`
    UPDATE cloudflare_orphans
       SET last_seen_at             = ?,
           asset_id_when_orphaned   = COALESCE(asset_id_when_orphaned,   ?),
           project_id_when_orphaned = COALESCE(project_id_when_orphaned, ?),
           name_when_orphaned       = COALESCE(name_when_orphaned,       ?)
     WHERE uid = ? AND purged_at IS NULL
  `).run(now, context.assetId, context.projectId, context.name, uid);
}

export function listActiveOrphans(): CloudflareOrphan[] {
  const rows = getCanonicalAssetDb()
    .prepare(`SELECT * FROM cloudflare_orphans WHERE purged_at IS NULL ORDER BY last_seen_at DESC`)
    .all() as Row[];
  return rows.map(rowToOrphan);
}

export function getOrphan(uid: string): CloudflareOrphan | null {
  const row = getCanonicalAssetDb()
    .prepare(`SELECT * FROM cloudflare_orphans WHERE uid = ?`)
    .get(uid) as Row | undefined;
  return row ? rowToOrphan(row) : null;
}

export function markOrphanPurged(uid: string): void {
  const now = new Date().toISOString();
  getCanonicalAssetDb()
    .prepare(`UPDATE cloudflare_orphans SET purged_at = ? WHERE uid = ?`)
    .run(now, uid);
}

export function markOrphanAttempt(uid: string, error: string | null): void {
  const now = new Date().toISOString();
  getCanonicalAssetDb()
    .prepare(`UPDATE cloudflare_orphans SET attempts = attempts + 1, last_seen_at = ?, last_error = ? WHERE uid = ?`)
    .run(now, error, uid);
}

