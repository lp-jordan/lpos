/**
 * Internal Review store.
 *
 * One named LPOS-hosted review bundle per row in `internal_reviews`. Asset
 * membership lives in `internal_review_assets` keyed by (review_id, asset_id)
 * with a `position` for reel order.
 *
 * Fully independent of the `deliverables` / Frame.io-review-link store — there
 * is no Frame.io state here. See docs/internal-review-spec.md.
 */

import { randomUUID } from 'node:crypto';
import { getCoreDb } from './core-db';
import type {
  InternalReview,
  InternalReviewAsset,
  InternalReviewStatus,
  InternalReviewWithAssets,
} from '@/lib/models/internal-review';

interface InternalReviewRow {
  review_id: string;
  project_id: string;
  name: string;
  status: InternalReviewStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface InternalReviewAssetRow {
  review_id: string;
  asset_id: string;
  position: number;
  added_at: string;
}

function rowToReview(row: InternalReviewRow): InternalReview {
  return {
    reviewId: row.review_id,
    projectId: row.project_id,
    name: row.name,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function rowToAsset(row: InternalReviewAssetRow): InternalReviewAsset {
  return {
    reviewId: row.review_id,
    assetId: row.asset_id,
    position: row.position,
    addedAt: row.added_at,
  };
}

export interface CreateInternalReviewInput {
  projectId: string;
  name: string;
  createdBy: string;
  /** Ordered asset ids — stored in array order as `position`. */
  assetIds: string[];
}

export function createInternalReview(input: CreateInternalReviewInput): InternalReview {
  const db = getCoreDb();
  const now = new Date().toISOString();
  const reviewId = randomUUID();

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO internal_reviews
         (review_id, project_id, name, status, created_by, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, NULL)`,
    ).run(reviewId, input.projectId, input.name, input.createdBy, now, now);

    const insertAsset = db.prepare(
      `INSERT INTO internal_review_assets (review_id, asset_id, position, added_at)
       VALUES (?, ?, ?, ?)`,
    );
    input.assetIds.forEach((assetId, idx) => {
      insertAsset.run(reviewId, assetId, idx, now);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    reviewId,
    projectId: input.projectId,
    name: input.name,
    status: 'active',
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
  };
}

export function getInternalReview(reviewId: string): InternalReview | null {
  const row = getCoreDb()
    .prepare(`SELECT * FROM internal_reviews WHERE review_id = ?`)
    .get(reviewId) as InternalReviewRow | undefined;
  return row ? rowToReview(row) : null;
}

export function getInternalReviewAssets(reviewId: string): InternalReviewAsset[] {
  const rows = getCoreDb()
    .prepare(
      `SELECT * FROM internal_review_assets WHERE review_id = ? ORDER BY position ASC, added_at ASC`,
    )
    .all(reviewId) as InternalReviewAssetRow[];
  return rows.map(rowToAsset);
}

export function getInternalReviewWithAssets(reviewId: string): InternalReviewWithAssets | null {
  const review = getInternalReview(reviewId);
  if (!review) return null;
  const assets = getInternalReviewAssets(reviewId);
  return { ...review, assets, assetCount: assets.length };
}

export function listInternalReviewsForProject(projectId: string): InternalReviewWithAssets[] {
  const db = getCoreDb();
  const rows = db
    .prepare(`SELECT * FROM internal_reviews WHERE project_id = ? ORDER BY created_at DESC`)
    .all(projectId) as InternalReviewRow[];

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.review_id);
  const placeholders = ids.map(() => '?').join(', ');
  const assetRows = db
    .prepare(
      `SELECT * FROM internal_review_assets
       WHERE review_id IN (${placeholders})
       ORDER BY position ASC, added_at ASC`,
    )
    .all(...ids) as InternalReviewAssetRow[];

  const assetsByReview = new Map<string, InternalReviewAsset[]>();
  for (const ar of assetRows) {
    const arr = assetsByReview.get(ar.review_id) ?? [];
    arr.push(rowToAsset(ar));
    assetsByReview.set(ar.review_id, arr);
  }

  return rows.map((r) => {
    const review = rowToReview(r);
    const assets = assetsByReview.get(review.reviewId) ?? [];
    return { ...review, assets, assetCount: assets.length };
  });
}

export interface UpdateInternalReviewInput {
  name?: string;
  status?: InternalReviewStatus;
}

export function updateInternalReview(
  reviewId: string,
  patch: UpdateInternalReviewInput,
): InternalReview | null {
  const db = getCoreDb();
  const current = db
    .prepare(`SELECT * FROM internal_reviews WHERE review_id = ?`)
    .get(reviewId) as InternalReviewRow | undefined;
  if (!current) return null;

  const now = new Date().toISOString();
  const name = patch.name ?? current.name;
  const status = patch.status ?? current.status;
  // Stamp revoked_at when transitioning into 'revoked'; clear it on reactivate.
  const revokedAt =
    patch.status === undefined
      ? current.revoked_at
      : patch.status === 'revoked'
        ? (current.status === 'revoked' ? current.revoked_at : now)
        : null;

  db.prepare(
    `UPDATE internal_reviews
     SET name = ?, status = ?, revoked_at = ?, updated_at = ?
     WHERE review_id = ?`,
  ).run(name, status, revokedAt, now, reviewId);

  return getInternalReview(reviewId);
}

/** Replace the entire asset membership (and re-number positions) for a review. */
export function setInternalReviewAssets(reviewId: string, assetIds: string[]): void {
  const db = getCoreDb();
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM internal_review_assets WHERE review_id = ?`).run(reviewId);
    const insertAsset = db.prepare(
      `INSERT INTO internal_review_assets (review_id, asset_id, position, added_at)
       VALUES (?, ?, ?, ?)`,
    );
    assetIds.forEach((assetId, idx) => insertAsset.run(reviewId, assetId, idx, now));
    db.prepare(`UPDATE internal_reviews SET updated_at = ? WHERE review_id = ?`).run(now, reviewId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function deleteInternalReview(reviewId: string): boolean {
  const db = getCoreDb();
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM internal_review_assets WHERE review_id = ?`).run(reviewId);
    const res = db.prepare(`DELETE FROM internal_reviews WHERE review_id = ?`).run(reviewId);
    db.exec('COMMIT');
    return res.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
