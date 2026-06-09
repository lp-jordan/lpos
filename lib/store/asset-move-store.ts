import { getCoreDb, withTransaction } from '@/lib/store/core-db';
import { getCanonicalAssetDb } from '@/lib/store/canonical-asset-db';
import { getActivityDb } from '@/lib/store/activity-db';

/**
 * Move one or more assets from one project to another. v22-ish feature
 * (Phase: cross-project asset reassignment) — touches three databases:
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
 *   - activity.sqlite: existing events for the asset in the source project
 *     get their `project_id` rewritten to the target. Keeps the asset's
 *     history coherent under its new home; the new asset.moved event we
 *     record encodes the from/to in its impact_json so the audit chain is
 *     intact.
 *
 * Frame.io references on the asset (frameio.assetId / stackId / playerUrl /
 * reviewLink / comments) are intentionally left untouched — moving the asset
 * on Frame.io is OUT OF SCOPE per the spec ("LPOS-only move"). The UI surfaces
 * a one-time warning explaining the history-split before the move proceeds.
 *
 * Cross-DB note: the three SQLite databases live in separate files, so we
 * can't wrap the whole operation in a single transaction. We do per-DB
 * transactions, which gives us per-DB atomicity. A crash between DB writes
 * is theoretically possible; for v1 we accept that tradeoff (moves are
 * admin-initiated and rare).
 */

export interface AssetMoveResult {
  movedAssetIds: string[];
  failedAssetIds: Array<{ assetId: string; reason: string }>;
}

export function moveAssetsBetweenProjects(input: {
  fromProjectId: string;
  toProjectId: string;
  assetIds: string[];
}): AssetMoveResult {
  const { fromProjectId, toProjectId, assetIds } = input;
  if (fromProjectId === toProjectId) {
    return {
      movedAssetIds: [],
      failedAssetIds: assetIds.map((id) => ({ assetId: id, reason: 'Source and target project are the same' })),
    };
  }

  const moved: string[] = [];
  const failed: Array<{ assetId: string; reason: string }> = [];

  const canonicalDb = getCanonicalAssetDb();
  const coreDb = getCoreDb();
  const activityDb = getActivityDb();
  const now = new Date().toISOString();

  for (const assetId of assetIds) {
    // Verify the asset exists in the source project. We hit canonical DB —
    // it's the source of truth for assets.
    const existing = canonicalDb
      .prepare('SELECT asset_id, project_id FROM assets WHERE asset_id = ?')
      .get(assetId) as { asset_id: string; project_id: string } | undefined;
    if (!existing) {
      failed.push({ assetId, reason: 'Asset not found' });
      continue;
    }
    if (existing.project_id !== fromProjectId) {
      failed.push({ assetId, reason: `Asset is not in project ${fromProjectId} (currently ${existing.project_id})` });
      continue;
    }

    try {
      // Canonical DB — move the asset row itself.
      withTransaction(canonicalDb, () => {
        canonicalDb
          .prepare('UPDATE assets SET project_id = ?, updated_at = ? WHERE asset_id = ?')
          .run(toProjectId, now, assetId);
      });

      // Core DB — update legacy share links + drop old-project deliverable links.
      // `asset_share_links` PK is (project_id, asset_id, share_id), so updating
      // project_id in place is safe as long as the same share_id doesn't exist
      // in the target project (it won't — share_ids are UUIDs).
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

      // Activity DB — rewrite historical events' project_id so the new
      // project's activity tab surfaces the asset's full history. New
      // asset.moved event recorded by the API route after the loop preserves
      // the audit chain (it embeds from/to in impact_json).
      withTransaction(activityDb, () => {
        activityDb
          .prepare('UPDATE activity_events SET project_id = ? WHERE asset_id = ? AND project_id = ?')
          .run(toProjectId, assetId, fromProjectId);
      });

      moved.push(assetId);
    } catch (err) {
      failed.push({ assetId, reason: (err as Error).message });
    }
  }

  return { movedAssetIds: moved, failedAssetIds: failed };
}
