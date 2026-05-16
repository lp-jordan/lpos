/**
 * Phase E: Deliverable publish flow.
 *
 * One function — `createDeliverableForAssets` — handles every entry point's
 * "create a share link" intent. It:
 *
 *   1. Resolves each LPOS asset's Frame.io address — prefer stack_id (so the
 *      share auto-resolves to head_version after subsequent uploads), fall back
 *      to file_id when no stack exists yet for that asset.
 *   2. Creates the Frame.io share (POST /shares) with the resolved IDs.
 *   3. Persists the deliverable in our DB (deliverables + deliverable_assets).
 *   4. Mirrors the share into the legacy share_assets table so the existing
 *      slide-in panel still sees it during the migration window. Removed in E6.
 *
 * If an asset has neither stackId nor assetId on Frame.io, it's silently
 * dropped from the share with a warning — Frame.io can't reference something
 * it doesn't have. Callers are expected to gate the modal so users aren't
 * surprised by missing assets, but the publish path is defensive either way.
 */

import { getAsset } from '@/lib/store/media-registry';
import { createShareLink, type FrameIOShare } from '@/lib/services/frameio';
import {
  createDeliverable,
  type CreateDeliverableInput,
} from '@/lib/store/deliverable-store';
import type { Deliverable, DeliverableSettings } from '@/lib/models/deliverable';

export interface CreateDeliverableForAssetsInput {
  projectId: string;
  assetIds: string[];
  name: string;
  createdBy: string;
  expiresAt?: string | null;
  settings?: DeliverableSettings;
}

export interface CreateDeliverableForAssetsResult {
  deliverable: Deliverable;
  /** Asset IDs from the request that had no Frame.io presence and were skipped. */
  skippedAssetIds: string[];
  /** The Frame.io share record, in case the caller wants the raw URL fields. */
  share: FrameIOShare;
}

export async function createDeliverableForAssets(
  input: CreateDeliverableForAssetsInput,
): Promise<CreateDeliverableForAssetsResult> {
  const { projectId, assetIds, name, createdBy, expiresAt, settings } = input;

  if (!name || !name.trim()) {
    throw new Error('Deliverable name is required.');
  }
  if (assetIds.length === 0) {
    throw new Error('Deliverable must contain at least one asset.');
  }

  // Resolve each asset's preferred Frame.io ID. Stack > file. Drop if neither.
  type Resolved = {
    assetId: string;
    frameioStackId: string | null;
    frameioFileId: string | null;
    frameioRefForShare: string;
  };
  const resolved: Resolved[] = [];
  const skipped: string[] = [];

  for (const assetId of assetIds) {
    const asset = getAsset(projectId, assetId);
    if (!asset) {
      skipped.push(assetId);
      continue;
    }
    const stackId = asset.frameio.stackId;
    const fileId = asset.frameio.assetId;
    if (stackId) {
      resolved.push({
        assetId,
        frameioStackId: stackId,
        frameioFileId: fileId,
        frameioRefForShare: stackId,
      });
    } else if (fileId) {
      resolved.push({
        assetId,
        frameioStackId: null,
        frameioFileId: fileId,
        frameioRefForShare: fileId,
      });
    } else {
      console.warn(
        `[deliverable-publish] asset ${assetId} has no Frame.io stack or file — skipping`,
      );
      skipped.push(assetId);
    }
  }

  if (resolved.length === 0) {
    throw new Error(
      'None of the selected assets are uploaded to Frame.io yet. Upload first, then create the deliverable.',
    );
  }

  // Create the share with the resolved Frame.io IDs. The frameio.ts helper has
  // a not-found-retry loop, so if Frame.io rejects one of our IDs as missing
  // it'll be dropped automatically — we then need to reconcile our `resolved`
  // list. The helper returns fileCount (= ids that survived); if it shrank,
  // we don't know which IDs were dropped, so we can't surgically remove them.
  // Compromise: trust our local state — if the share creation throws we surface
  // the error; if it succeeds with fewer files than we asked for, we still
  // record every resolved asset in our DB. A reconciler job (out of scope here)
  // can later detect orphaned deliverable_assets rows.
  const share = await createShareLink(
    resolved.map((r) => r.frameioRefForShare),
    name,
    settings?.downloading_enabled !== undefined
      ? { downloading_enabled: settings.downloading_enabled }
      : undefined,
  );

  // Persist locally — one transaction.
  const createInput: CreateDeliverableInput = {
    projectId,
    name,
    frameioShareId: share.id,
    shortUrl: share.shareUrl,
    createdBy,
    expiresAt: expiresAt ?? null,
    settings: settings ?? {},
    assets: resolved.map((r) => ({
      assetId: r.assetId,
      frameioStackId: r.frameioStackId,
      frameioFileId: r.frameioFileId,
    })),
  };
  const deliverable = createDeliverable(createInput);

  // Legacy mirror removed in E6 — neither the SharesPanel nor the MediaDetail
  // per-asset dropdown read from share_assets/asset_share_links anymore. The
  // v12 backfill migration converted pre-existing rows; new deliverables live
  // only in the new tables.

  return {
    deliverable,
    skippedAssetIds: skipped,
    share,
  };
}
