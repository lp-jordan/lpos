import { getCoreDb, withTransaction } from '@/lib/store/core-db';
import { getCanonicalAssetDb } from '@/lib/store/canonical-asset-db';
import {
  findMoveCollision,
  computeNextFreeAssetName,
  patchCanonicalMediaAsset,
} from '@/lib/store/canonical-asset-store';

/**
 * Move one or more assets from one project to another. Touches two databases:
 *
 *   - canonical-assets.sqlite: `assets.project_id` UPDATE. Child rows
 *     (asset_versions / media_files / distribution_records / editorial_links)
 *     reference asset_id, not project_id, so they follow the move implicitly.
 *
 *   - core.sqlite: `asset_share_links.project_id` UPDATE. Legacy table whose
 *     PK is (project_id, asset_id, share_id), so we update in place rather
 *     than insert+delete. `deliverable_assets` rows on the OLD project's
 *     deliverables are DROPPED (deliverables are project-scoped; we never
 *     auto-add to a target-project deliverable because the user usually
 *     wants to assemble a fresh delivery from the new project's UI).
 *
 * Activity history (activity_events) is intentionally LEFT ALONE: historical
 * events stay at the source project, so the asset's pre-move story remains
 * visible from the source's perspective ("this asset was here, here's what
 * happened"). Post-move events naturally land at the target — the move
 * route writes the `asset.moved` event with `project_id: toProjectId`, and
 * any subsequent activity emitted by the asset's child operations (comments,
 * re-transcribes, deliveries, etc.) inherits the asset's new project_id.
 * The asymmetry is honest: source = pre-move history, target = post-move.
 *
 * Frame.io references on the asset (frameio.assetId / stackId / playerUrl /
 * reviewLink / comments) are intentionally left untouched — moving the asset
 * on Frame.io is OUT OF SCOPE per the spec ("LPOS-only move"). The UI surfaces
 * a one-time warning explaining the history-split before the move proceeds.
 *
 * Cross-DB note: the two SQLite databases live in separate files, so we
 * can't wrap the whole operation in a single transaction. We do per-DB
 * transactions, which gives us per-DB atomicity. A crash between DB writes
 * is theoretically possible; for v1 we accept that tradeoff (moves are
 * admin-initiated and rare).
 *
 * Name collisions: if the moving asset's (normalized) name already exists in
 * the target project, the caller must supply a per-asset `resolution` — the
 * move UI surfaces this via a preflight check (findMoveCollision). Without a
 * resolution, a colliding asset FAILS with `unresolved-collision` so we can
 * never silently drop two same-named "B1"s into one project. Resolutions:
 *   - 'skip'        → leave the asset in the source (used for exact dupes).
 *   - 'rename'      → move it, then append " (n)" so both survive distinctly.
 *   - 'new_version' → MERGE: re-parent the moving asset's versions onto the
 *                     colliding destination asset as new version numbers, then
 *                     delete the emptied moving shell. See mergeAssetAsNewVersions.
 */

export type MoveResolutionAction = 'rename' | 'new_version' | 'skip';

export interface MoveResolution {
  action: MoveResolutionAction;
}

export interface AssetMoveResult {
  /** Assets that landed in the target as-is or via rename (still their own asset). */
  movedAssetIds: string[];
  /** Renamed-on-collision moves (subset of movedAssetIds), with the new display name. */
  renamed: Array<{ assetId: string; newName: string }>;
  /** Assets merged into a destination asset as new versions (the moving shell is gone). */
  merged: Array<{ assetId: string; destAssetId: string; asVersion: number }>;
  /** Assets deliberately not moved (e.g. exact duplicate → skip, leave in source). */
  skipped: Array<{ assetId: string; reason: string }>;
  failedAssetIds: Array<{ assetId: string; reason: string }>;
}

/**
 * Plain move of a single asset: flip its project_id (canonical DB) + repoint
 * legacy share links and drop old-project deliverable memberships (core DB).
 * Factored out so the 'rename' resolution can reuse it before renaming.
 */
function performPlainMove(assetId: string, fromProjectId: string, toProjectId: string, now: string): void {
  const canonicalDb = getCanonicalAssetDb();
  const coreDb = getCoreDb();

  withTransaction(canonicalDb, () => {
    canonicalDb
      .prepare('UPDATE assets SET project_id = ?, updated_at = ? WHERE asset_id = ?')
      .run(toProjectId, now, assetId);
  });

  // `asset_share_links` PK is (project_id, asset_id, share_id), so updating
  // project_id in place is safe as long as the same share_id doesn't exist in
  // the target project (it won't — share_ids are UUIDs).
  withTransaction(coreDb, () => {
    coreDb
      .prepare('UPDATE asset_share_links SET project_id = ? WHERE asset_id = ? AND project_id = ?')
      .run(toProjectId, assetId, fromProjectId);

    coreDb
      .prepare(
        `DELETE FROM deliverable_assets
         WHERE asset_id = ?
           AND deliverable_id IN (
             SELECT deliverable_id FROM deliverables WHERE project_id = ?
           )`,
      )
      .run(assetId, fromProjectId);
  });
}

/**
 * Merge a moving asset's version chain onto an existing destination asset, stacking its
 * versions ABOVE the destination's highest number so the moved content becomes the newest
 * version(s). Child rows (media_files / distribution_records / transcription_jobs) reference
 * asset_version_id and so follow their version automatically; editorial_links + ingest_exceptions
 * reference asset_id directly and are re-pointed explicitly (editorial_links would otherwise be
 * cascade-deleted with the shell). The emptied moving asset row is then deleted.
 *
 * Returns the first (lowest) new version number the moved content occupies on the destination.
 */
function mergeAssetAsNewVersions(
  movingAssetId: string,
  destAssetId: string,
  fromProjectId: string,
  toProjectId: string,
  now: string,
): { asVersion: number } {
  const canonicalDb = getCanonicalAssetDb();
  const coreDb = getCoreDb();
  let firstNewVersion = 1;

  withTransaction(canonicalDb, () => {
    const maxRow = canonicalDb
      .prepare('SELECT MAX(version_number) AS n FROM asset_versions WHERE asset_id = ?')
      .get(destAssetId) as { n: number | null } | undefined;
    const base = maxRow?.n ?? 0;
    firstNewVersion = base + 1;

    // Re-point the moving asset's versions ascending. New numbers are strictly greater than
    // the destination's existing max, so UNIQUE(asset_id, version_number) can't clash.
    const movingVersions = canonicalDb
      .prepare(
        'SELECT asset_version_id FROM asset_versions WHERE asset_id = ? ORDER BY version_number ASC, created_at ASC',
      )
      .all(movingAssetId) as Array<{ asset_version_id: string }>;
    movingVersions.forEach((v, i) => {
      canonicalDb
        .prepare('UPDATE asset_versions SET asset_id = ?, version_number = ?, updated_at = ? WHERE asset_version_id = ?')
        .run(destAssetId, base + i + 1, now, v.asset_version_id);
    });

    // Re-point asset_id-scoped rows so nothing is lost when the shell is deleted.
    canonicalDb
      .prepare('UPDATE editorial_links SET asset_id = ?, updated_at = ? WHERE asset_id = ?')
      .run(destAssetId, now, movingAssetId);
    canonicalDb
      .prepare('UPDATE ingest_exceptions SET asset_id = ?, updated_at = ? WHERE asset_id = ?')
      .run(destAssetId, now, movingAssetId);

    canonicalDb.prepare('UPDATE assets SET updated_at = ? WHERE asset_id = ?').run(now, destAssetId);

    // Delete the now-empty moving shell. Its versions/editorial_links were re-pointed above,
    // so ON DELETE CASCADE has nothing of value left to remove.
    canonicalDb.prepare('DELETE FROM assets WHERE asset_id = ?').run(movingAssetId);
  });

  withTransaction(coreDb, () => {
    // Share links follow the content onto the destination asset in the target project.
    coreDb
      .prepare('UPDATE asset_share_links SET project_id = ?, asset_id = ? WHERE asset_id = ?')
      .run(toProjectId, destAssetId, movingAssetId);
    // The moving asset ceases to exist — drop all its deliverable memberships.
    coreDb.prepare('DELETE FROM deliverable_assets WHERE asset_id = ?').run(movingAssetId);
  });

  return { asVersion: firstNewVersion };
}

export function moveAssetsBetweenProjects(input: {
  fromProjectId: string;
  toProjectId: string;
  assetIds: string[];
  resolutions?: Record<string, MoveResolution>;
}): AssetMoveResult {
  const { fromProjectId, toProjectId, assetIds, resolutions = {} } = input;
  const empty: AssetMoveResult = {
    movedAssetIds: [],
    renamed: [],
    merged: [],
    skipped: [],
    failedAssetIds: [],
  };
  if (fromProjectId === toProjectId) {
    return {
      ...empty,
      failedAssetIds: assetIds.map((id) => ({ assetId: id, reason: 'Source and target project are the same' })),
    };
  }

  const result: AssetMoveResult = { ...empty };
  const canonicalDb = getCanonicalAssetDb();
  const now = new Date().toISOString();

  for (const assetId of assetIds) {
    // Verify the asset exists in the source project. Canonical DB is the source of truth.
    const existing = canonicalDb
      .prepare('SELECT asset_id, project_id FROM assets WHERE asset_id = ?')
      .get(assetId) as { asset_id: string; project_id: string } | undefined;
    if (!existing) {
      result.failedAssetIds.push({ assetId, reason: 'Asset not found' });
      continue;
    }
    if (existing.project_id !== fromProjectId) {
      result.failedAssetIds.push({
        assetId,
        reason: `Asset is not in project ${fromProjectId} (currently ${existing.project_id})`,
      });
      continue;
    }

    const resolution = resolutions[assetId];
    // Re-detect the collision server-side (defensive — never trust the client's preflight to
    // be current). A resolution without a live collision falls back to a plain move.
    const collision = findMoveCollision(toProjectId, assetId);

    // Explicit user skip wins regardless — they chose not to bring this asset over.
    if (resolution?.action === 'skip') {
      result.skipped.push({
        assetId,
        reason: collision?.isExactDuplicate ? 'exact-duplicate' : 'skipped-by-user',
      });
      continue;
    }

    // A live collision with no resolution is a hard stop — the UI must resolve it first.
    if (collision && !resolution) {
      result.failedAssetIds.push({ assetId, reason: 'unresolved-collision' });
      continue;
    }

    try {
      if (collision && resolution?.action === 'new_version') {
        const { asVersion } = mergeAssetAsNewVersions(
          assetId,
          collision.destAssetId,
          fromProjectId,
          toProjectId,
          now,
        );
        result.merged.push({ assetId, destAssetId: collision.destAssetId, asVersion });
        continue;
      }

      // Plain move — covers "no collision" and "collision + rename".
      performPlainMove(assetId, fromProjectId, toProjectId, now);

      if (collision && resolution?.action === 'rename') {
        // Compute the free name AFTER the move: the asset is now in the target, so its own
        // "B1" occupies the base slot alongside the pre-existing "B1" → we get "B1 (1)".
        const newName = computeNextFreeAssetName(toProjectId, collision.movingName);
        patchCanonicalMediaAsset(toProjectId, assetId, { name: newName });
        result.renamed.push({ assetId, newName });
      }

      result.movedAssetIds.push(assetId);
    } catch (err) {
      result.failedAssetIds.push({ assetId, reason: (err as Error).message });
    }
  }

  return result;
}
