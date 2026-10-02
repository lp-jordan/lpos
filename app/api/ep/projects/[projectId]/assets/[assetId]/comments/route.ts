import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getAsset } from '@/lib/store/media-registry';
import {
  getCurrentAssetVersion,
  listAssetVersionsWithFrameioFileId,
} from '@/lib/store/canonical-asset-store';
import { getThreadedCommentsForAssetAllVersions } from '@/lib/store/media-comment-store';
import { getUserById } from '@/lib/store/user-store';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * GET /api/ep/projects/:projectId/assets/:assetId/comments
 *
 * Returns every comment on an asset, across ALL versions, with author names
 * resolved. EditPanel places these as review markers on the source Resolve
 * timeline.
 *
 * Source of truth is the LPOS comments system (`media_comments`), whatever
 * the comment came from: the LPOS UI, an LP Share link, or the legacy
 * Frame.io import. `id` is the stable local comment_id and is what EditPanel
 * tags its markers with (`lpos:{id}`).
 *
 * `frameioCommentId` is still returned, but only so EditPanel can re-tag
 * markers it placed before 2026-10-02 (`frameio:{id}`) in place instead of
 * duplicating them. Older EditPanel builds also key on it, so keeping the
 * field means they keep working (they just don't see LPOS-only comments).
 *
 * All versions: notes stay pinned to the version the reviewer was watching,
 * and EditPanel has no version picker, so each comment carries
 * `assetVersionId` / `versionNumber` / `isCurrentVersion` and EditPanel labels
 * markers from an older cut.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  try {
    // Every version of the asset (newest first). Only the version number is
    // used here; the Frame.io file id this helper also returns is ignored.
    const versions = listAssetVersionsWithFrameioFileId(assetId);
    const currentVersionId = getCurrentAssetVersion(assetId)?.asset_version_id
      ?? versions[0]?.assetVersionId
      ?? null;

    const { comments, rowLookup } = getThreadedCommentsForAssetAllVersions(assetId);
    const versionNumberById = new Map(versions.map((v) => [v.assetVersionId, v.versionNumber]));

    // LPOS-authored comments get their LPOS user's current display name;
    // guests and imported reviewers keep the captured name.
    const named = comments.map((c) => {
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
