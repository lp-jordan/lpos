import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getAsset } from '@/lib/store/media-registry';
import {
  getCurrentAssetVersion,
  listAssetVersionsWithFrameioFileId,
} from '@/lib/store/canonical-asset-store';
import { getThreadedCommentsForAssetAllVersions } from '@/lib/store/media-comment-store';
import { pullFrameioCommentsForAssetVersion } from '@/lib/services/frameio-comment-sync';
import { getUserById } from '@/lib/store/user-store';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * GET /api/ep/projects/:projectId/assets/:assetId/comments
 *
 * Returns comments for an asset, with author names resolved. EditPanel uses
 * these to place review markers on the source Resolve timeline (tagged
 * `frameio:{id}` per locked decision §11 #4 — tether stays through Phase 4).
 *
 * Reads from the local `media_comments` table. Identity model (decoupling
 * Step 3): `id` is ALWAYS the stable local comment_id; the Frame.io comment id
 * is a separate `frameioCommentId` field. EditPanel tethers its Resolve markers
 * on the Frame.io id, so we (a) return only comments that have a
 * frameioCommentId, and (b) surface it explicitly.
 *
 * ── ALL VERSIONS, and freshened from Frame.io before reading ────────────────
 * This route used to resolve one asset version (the current version's Frame.io
 * file) and read only that version's thread. Two ways comments went missing:
 *
 *   1. Version drift. A re-render mints a new asset version and a new Frame.io
 *      file, but notes stay pinned to the version the reviewer was watching.
 *      The LPOS UI compensates with version chips (`?version=`); editpanel has
 *      no such control, so every note on a superseded cut was invisible to it.
 *      Measured on prod at the time of the fix: 241 unresolved comments across
 *      84 assets sat on non-current versions.
 *   2. Staleness. The browser comments route pulls the live Frame.io thread
 *      before reading; this one didn't, so a comment whose webhook was missed
 *      stayed invisible to editpanel until a human happened to open that asset
 *      in LPOS.
 *
 * So: pull every version that has a Frame.io file (best-effort, throttled
 * per-file inside the sync service), then read across all versions. Each
 * comment carries `assetVersionId` / `versionNumber` / `isCurrentVersion` so
 * editpanel can label a marker that came from an older cut.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  try {
    const versions = listAssetVersionsWithFrameioFileId(assetId);   // newest-first
    const currentVersionId = getCurrentAssetVersion(assetId)?.asset_version_id
      ?? versions[0]?.assetVersionId
      ?? null;

    // Freshness pass. Sequential and best-effort: Frame.io being slow or down
    // must never fail the pull — editpanel then works off whatever is local.
    // `pullFrameioCommentsForAssetVersion` is throttled per file (15s) and
    // idempotent on the frameio_comment_id UNIQUE index, so repeated pulls
    // across a multi-timeline run cost one request per file at most.
    for (const version of versions) {
      if (!version.frameioFileId) continue;
      try {
        await pullFrameioCommentsForAssetVersion(
          { projectId, assetId, assetVersionId: version.assetVersionId },
          version.frameioFileId,
        );
      } catch (err) {
        console.warn(
          `[ep comments] live Frame.io pull failed for asset ${assetId} v${version.versionNumber} — serving local only:`,
          (err as Error).message,
        );
      }
    }

    const { comments, rowLookup } = getThreadedCommentsForAssetAllVersions(assetId);
    const versionNumberById = new Map(versions.map((v) => [v.assetVersionId, v.versionNumber]));

    // EditPanel can only tether markers on comments that exist in Frame.io, so
    // drop rows that were never mirrored (frameioCommentId === null). Then
    // resolve author names: LPOS-authored comments get their LPOS user's
    // current display name; external Frame.io reviewers keep the captured name.
    const named = comments
      .filter((c) => c.frameioCommentId != null)
      .map((c) => {
        const lookup   = rowLookup.get(c.id);
        const lposUser = lookup?.authorUserId ? getUserById(lookup.authorUserId) : null;
        return {
          ...c,
          authorName:       lposUser?.name ?? c.authorName,
          versionNumber:    c.assetVersionId ? versionNumberById.get(c.assetVersionId) ?? null : null,
          isCurrentVersion: c.assetVersionId != null && c.assetVersionId === currentVersionId,
        };
      });

    return NextResponse.json({
      comments: named,
      currentVersionId,
      versionCount: versions.length,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
