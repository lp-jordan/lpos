/**
 * Frame.io comment sync — on-demand pull.
 *
 * The live Frame.io webhook is the *awareness* channel (it produces
 * `frameio.comment.created` activity events that drive notifications). This
 * module is the *display / resilience* channel: it pulls the live Frame.io
 * comment thread for a single asset version into `media_comments` on demand,
 * the same way DriveWatcherService.scanProjectAssets re-lists a Drive folder
 * whenever a user opens it. So even if a webhook is ever missed (or was never
 * delivered), the comments a user is looking at are current.
 *
 * Idempotent: insertMediaComment short-circuits on the `frameio_comment_id`
 * UNIQUE index, so re-pulling only adds comments we don't already have and
 * never duplicates. It deliberately does NOT write activity events — notifying
 * someone about a comment they are actively viewing is pointless; that's the
 * webhook's job.
 *
 * Throttled per Frame.io file so rapid polling of the comments endpoint can't
 * hammer Frame.io's ~3 req/s ceiling. Callers should treat this as best-effort
 * and catch — a slow/down Frame.io must never break the comments UI.
 */

import { getComments } from '@/lib/services/frameio';
import { getCanonicalAssetDb } from '@/lib/store/canonical-asset-db';
import { insertMediaComment, getMediaCommentByFrameioId } from '@/lib/store/media-comment-store';

export interface FrameioCommentPullResult {
  fetched:   number;
  inserted:  number;
  skipped:   number;
  throttled: boolean;
}

interface PullScope {
  projectId:      string;
  assetId:        string;
  assetVersionId: string;
}

/**
 * Forward lookup: the Frame.io file id a given asset version was published to.
 * Mirror of `findAssetVersionByFrameioFileId` in the other direction. Returns
 * null for LPOS-native versions that were never pushed to Frame.io.
 */
export function getFrameioFileIdForAssetVersion(assetVersionId: string): string | null {
  const db  = getCanonicalAssetDb();
  const row = db.prepare(
    `SELECT provider_asset_id
       FROM distribution_records
      WHERE provider = 'frameio'
        AND asset_version_id = ?
        AND provider_asset_id IS NOT NULL
      ORDER BY attempt_number DESC
      LIMIT 1`,
  ).get(assetVersionId) as { provider_asset_id: string } | undefined;
  return row?.provider_asset_id ?? null;
}

// Per-file throttle: skip a pull if we pulled this file within the window.
// Bounds Frame.io load regardless of how aggressively the caller polls.
const PULL_THROTTLE_MS = 15_000;
const lastPullByFile = new Map<string, number>();

/**
 * Pull the live Frame.io comment thread for one asset version into
 * media_comments. Best-effort and idempotent. Throws only on a Frame.io API
 * failure (network / auth) — callers wanting graceful degradation should catch.
 */
export async function pullFrameioCommentsForAssetVersion(
  scope:  PullScope,
  fileId: string,
  opts?:  { force?: boolean },
): Promise<FrameioCommentPullResult> {
  const now  = Date.now();
  const last = lastPullByFile.get(fileId) ?? 0;
  if (!opts?.force && now - last < PULL_THROTTLE_MS) {
    return { fetched: 0, inserted: 0, skipped: 0, throttled: true };
  }
  // Stamp before the await so concurrent requests don't all fire a pull.
  lastPullByFile.set(fileId, now);

  const comments = await getComments(fileId);

  // Flatten top-level comments and their replies into one list, parents first
  // (so a reply's parent local comment_id resolves against a row we just wrote).
  const flat: Array<{ id: string; text: string; timestamp: number | null; duration: number | null; authorName: string; authorAvatar: string | null; createdAt: string; completed: boolean; parentFrameioId: string | null }> = [];
  for (const c of comments) {
    flat.push({ id: c.id, text: c.text, timestamp: c.timestamp, duration: c.duration, authorName: c.authorName, authorAvatar: c.authorAvatar, createdAt: c.createdAt, completed: c.completed, parentFrameioId: null });
    for (const r of c.replies) {
      flat.push({ id: r.id, text: r.text, timestamp: null, duration: null, authorName: r.authorName, authorAvatar: r.authorAvatar, createdAt: r.createdAt, completed: false, parentFrameioId: c.id });
    }
  }

  let fetched = 0, inserted = 0, skipped = 0;
  for (const c of flat) {
    fetched++;
    if (getMediaCommentByFrameioId(c.id)) { skipped++; continue; }

    let parentLocalCommentId: string | null = null;
    if (c.parentFrameioId) {
      const parent = getMediaCommentByFrameioId(c.parentFrameioId);
      parentLocalCommentId = parent?.commentId ?? null;
    }

    insertMediaComment({
      projectId:          scope.projectId,
      assetId:            scope.assetId,
      assetVersionId:     scope.assetVersionId,
      parentCommentId:    parentLocalCommentId,
      body:               c.text,
      timestampSeconds:   c.timestamp,
      durationSeconds:    c.duration,
      authorUserId:       null,               // external Frame.io reviewer; LPOS-authored rows already exist locally
      authorExternalName: c.authorName,
      authorAvatarUrl:    c.authorAvatar,
      source:             'frameio',
      frameioCommentId:   c.id,
      frameioFileId:      fileId,
      completed:          c.completed,
      createdAtOverride:  c.createdAt,
    });
    inserted++;
  }

  return { fetched, inserted, skipped, throttled: false };
}
