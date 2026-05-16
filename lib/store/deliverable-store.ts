/**
 * Phase E: Deliverables store.
 *
 * One named Frame.io share per row in `deliverables`. Asset membership lives in
 * `deliverable_assets` keyed by (deliverable_id, asset_id), each row remembering
 * which Frame.io stack or file ID we attached to the share for that asset.
 *
 * This store is the new home for review-link state. The legacy share_assets
 * and asset_share_links tables stay populated by old code paths until E6
 * migrates them into here and retires the old writers.
 */

import { randomUUID } from 'node:crypto';
import { getCoreDb } from './core-db';
import type {
  Deliverable,
  DeliverableAsset,
  DeliverableSettings,
  DeliverableWithAssets,
} from '@/lib/models/deliverable';

interface DeliverableRow {
  deliverable_id: string;
  project_id: string;
  name: string;
  frameio_share_id: string;
  short_url: string;
  expires_at: string | null;
  settings_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface DeliverableAssetRow {
  deliverable_id: string;
  asset_id: string;
  frameio_stack_id: string | null;
  frameio_file_id: string | null;
  added_at: string;
}

function rowToDeliverable(row: DeliverableRow): Deliverable {
  let settings: DeliverableSettings;
  try {
    settings = JSON.parse(row.settings_json) as DeliverableSettings;
  } catch {
    settings = {};
  }
  return {
    deliverableId: row.deliverable_id,
    projectId: row.project_id,
    name: row.name,
    frameioShareId: row.frameio_share_id,
    shortUrl: row.short_url,
    expiresAt: row.expires_at,
    settings,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAsset(row: DeliverableAssetRow): DeliverableAsset {
  return {
    deliverableId: row.deliverable_id,
    assetId: row.asset_id,
    frameioStackId: row.frameio_stack_id,
    frameioFileId: row.frameio_file_id,
    addedAt: row.added_at,
  };
}

export interface CreateDeliverableInput {
  projectId: string;
  name: string;
  frameioShareId: string;
  shortUrl: string;
  createdBy: string;
  expiresAt?: string | null;
  settings?: DeliverableSettings;
  assets: Array<{
    assetId: string;
    frameioStackId: string | null;
    frameioFileId: string | null;
  }>;
}

export function createDeliverable(input: CreateDeliverableInput): Deliverable {
  const db = getCoreDb();
  const now = new Date().toISOString();
  const deliverableId = randomUUID();

  const settingsJson = JSON.stringify(input.settings ?? {});

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO deliverables
         (deliverable_id, project_id, name, frameio_share_id, short_url,
          expires_at, settings_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      deliverableId,
      input.projectId,
      input.name,
      input.frameioShareId,
      input.shortUrl,
      input.expiresAt ?? null,
      settingsJson,
      input.createdBy,
      now,
      now,
    );

    const insertAsset = db.prepare(
      `INSERT INTO deliverable_assets
         (deliverable_id, asset_id, frameio_stack_id, frameio_file_id, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const a of input.assets) {
      insertAsset.run(
        deliverableId,
        a.assetId,
        a.frameioStackId,
        a.frameioFileId,
        now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    deliverableId,
    projectId: input.projectId,
    name: input.name,
    frameioShareId: input.frameioShareId,
    shortUrl: input.shortUrl,
    expiresAt: input.expiresAt ?? null,
    settings: input.settings ?? {},
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export function getDeliverable(deliverableId: string): Deliverable | null {
  const row = getCoreDb()
    .prepare(`SELECT * FROM deliverables WHERE deliverable_id = ?`)
    .get(deliverableId) as DeliverableRow | undefined;
  return row ? rowToDeliverable(row) : null;
}

export function getDeliverableAssets(deliverableId: string): DeliverableAsset[] {
  const rows = getCoreDb()
    .prepare(`SELECT * FROM deliverable_assets WHERE deliverable_id = ? ORDER BY added_at ASC`)
    .all(deliverableId) as DeliverableAssetRow[];
  return rows.map(rowToAsset);
}

export function listDeliverablesForProject(projectId: string): DeliverableWithAssets[] {
  const db = getCoreDb();
  const rows = db
    .prepare(`SELECT * FROM deliverables WHERE project_id = ? ORDER BY created_at DESC`)
    .all(projectId) as DeliverableRow[];

  if (rows.length === 0) return [];

  // One pass to batch-fetch all asset rows for these deliverables. Avoids N+1.
  const ids = rows.map((r) => r.deliverable_id);
  const placeholders = ids.map(() => '?').join(', ');
  const assetRows = db
    .prepare(
      `SELECT * FROM deliverable_assets
       WHERE deliverable_id IN (${placeholders})
       ORDER BY added_at ASC`,
    )
    .all(...ids) as DeliverableAssetRow[];

  const assetsByDeliverable = new Map<string, DeliverableAsset[]>();
  for (const ar of assetRows) {
    const arr = assetsByDeliverable.get(ar.deliverable_id) ?? [];
    arr.push(rowToAsset(ar));
    assetsByDeliverable.set(ar.deliverable_id, arr);
  }

  return rows.map((r) => {
    const d = rowToDeliverable(r);
    const assets = assetsByDeliverable.get(d.deliverableId) ?? [];
    return { ...d, assets, assetCount: assets.length };
  });
}

/** Find every deliverable that contains a given asset. Used by E7 auto-promote. */
export function findDeliverablesContainingAsset(assetId: string): Array<{
  deliverable: Deliverable;
  asset: DeliverableAsset;
}> {
  const db = getCoreDb();
  const assetRows = db
    .prepare(`SELECT * FROM deliverable_assets WHERE asset_id = ?`)
    .all(assetId) as DeliverableAssetRow[];

  if (assetRows.length === 0) return [];

  const deliverableIds = Array.from(new Set(assetRows.map((r) => r.deliverable_id)));
  const placeholders = deliverableIds.map(() => '?').join(', ');
  const dRows = db
    .prepare(`SELECT * FROM deliverables WHERE deliverable_id IN (${placeholders})`)
    .all(...deliverableIds) as DeliverableRow[];

  const dById = new Map(dRows.map((r) => [r.deliverable_id, rowToDeliverable(r)]));

  return assetRows
    .map((ar) => {
      const d = dById.get(ar.deliverable_id);
      if (!d) return null;
      return { deliverable: d, asset: rowToAsset(ar) };
    })
    .filter((x): x is { deliverable: Deliverable; asset: DeliverableAsset } => x !== null);
}

export interface UpdateDeliverableInput {
  name?: string;
  expiresAt?: string | null;
  settings?: DeliverableSettings;
}

export function updateDeliverable(
  deliverableId: string,
  patch: UpdateDeliverableInput,
): Deliverable | null {
  const db = getCoreDb();
  const current = db
    .prepare(`SELECT * FROM deliverables WHERE deliverable_id = ?`)
    .get(deliverableId) as DeliverableRow | undefined;
  if (!current) return null;

  const now = new Date().toISOString();
  const name = patch.name ?? current.name;
  const expiresAt = patch.expiresAt !== undefined ? patch.expiresAt : current.expires_at;
  const settingsJson = patch.settings !== undefined
    ? JSON.stringify(patch.settings)
    : current.settings_json;

  db.prepare(
    `UPDATE deliverables
     SET name = ?, expires_at = ?, settings_json = ?, updated_at = ?
     WHERE deliverable_id = ?`,
  ).run(name, expiresAt, settingsJson, now, deliverableId);

  return getDeliverable(deliverableId);
}

/**
 * Update the recorded Frame.io stack/file for one asset in one deliverable.
 * Called by the auto-promote path (E7) when an asset's stack ID changes —
 * e.g. v2 upload created a stack where there was previously only a file.
 */
export function updateDeliverableAssetFrameio(
  deliverableId: string,
  assetId: string,
  patch: { frameioStackId?: string | null; frameioFileId?: string | null },
): void {
  const db = getCoreDb();
  const fields: string[] = [];
  const params: (string | null)[] = [];
  if (patch.frameioStackId !== undefined) {
    fields.push('frameio_stack_id = ?');
    params.push(patch.frameioStackId);
  }
  if (patch.frameioFileId !== undefined) {
    fields.push('frameio_file_id = ?');
    params.push(patch.frameioFileId);
  }
  if (fields.length === 0) return;
  params.push(deliverableId, assetId);
  db.prepare(
    `UPDATE deliverable_assets SET ${fields.join(', ')}
     WHERE deliverable_id = ? AND asset_id = ?`,
  ).run(...params);
}

export function addAssetToDeliverable(
  deliverableId: string,
  asset: { assetId: string; frameioStackId: string | null; frameioFileId: string | null },
): void {
  const now = new Date().toISOString();
  getCoreDb().prepare(
    `INSERT INTO deliverable_assets
       (deliverable_id, asset_id, frameio_stack_id, frameio_file_id, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(deliverable_id, asset_id) DO UPDATE SET
       frameio_stack_id = excluded.frameio_stack_id,
       frameio_file_id  = excluded.frameio_file_id`,
  ).run(deliverableId, asset.assetId, asset.frameioStackId, asset.frameioFileId, now);
}

export function removeAssetFromDeliverable(deliverableId: string, assetId: string): void {
  getCoreDb().prepare(
    `DELETE FROM deliverable_assets WHERE deliverable_id = ? AND asset_id = ?`,
  ).run(deliverableId, assetId);
}

export function deleteDeliverable(deliverableId: string): boolean {
  const result = getCoreDb()
    .prepare(`DELETE FROM deliverables WHERE deliverable_id = ?`)
    .run(deliverableId);
  return result.changes > 0;
}
