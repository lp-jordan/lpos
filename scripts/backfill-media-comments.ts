/**
 * One-shot backfill: populate `media_comments` with historical Frame.io
 * comments so Phase 1's read swap has data to serve from day one.
 *
 * See docs/local-comments-refactor-spec.md §10.1 for the full design.
 *
 * What it does:
 *   1. Walks every distribution_records row with provider='frameio' AND
 *      provider_asset_id IS NOT NULL — i.e. every Frame.io-uploaded asset
 *      version we know about.
 *   2. Calls `getComments(fileId)` on each to fetch the live Frame.io thread.
 *   3. INSERTs each comment into `media_comments` with `source='frameio'`,
 *      pinned to the (projectId, assetId, assetVersionId) tuple from the
 *      distribution_records JOIN (locked decision §11 #1: version-scoped).
 *   4. Joins against per-project `comment-authors.json` to backfill
 *      `author_user_id` for comments LPOS users posted.
 *   5. Joins against per-project `comment-replies.json` to set
 *      `parent_comment_id` for replies (Frame.io v4 has no native reply
 *      endpoint, so LPOS-posted replies were stored as fake top-level
 *      comments — the JSON shim records the parent mapping).
 *
 * Idempotent: inserts use `INSERT OR IGNORE` semantics via the store's
 * frameio-id pre-check. Safe to re-run.
 *
 * Usage:
 *   npm run backfill:media-comments              # full run, all projects
 *   npm run backfill:media-comments -- --dry     # show counts, no writes
 *   npm run backfill:media-comments -- --project=<id>  # one project only
 *   npm run backfill:media-comments -- --verbose # log every insert
 *
 * Concurrency: serial per asset (Frame.io rate-limits aggressive parallel
 * pulls). Roughly ~1 API call per asset; 100 assets = 100 calls = ~30s at
 * Frame.io's typical 3 req/s ceiling.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCanonicalAssetDb } from '@/lib/store/canonical-asset-db';
import { getComments, type FrameIOComment } from '@/lib/services/frameio';
import { insertMediaComment, getMediaCommentByFrameioId } from '@/lib/store/media-comment-store';

interface Args {
  dry:        boolean;
  verbose:    boolean;
  projectId:  string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    dry:       argv.includes('--dry'),
    verbose:   argv.includes('--verbose'),
    projectId: argv.find((a) => a.startsWith('--project='))?.split('=')[1] ?? null,
  };
}

interface BackfillTarget {
  projectId:        string;
  assetId:          string;
  assetVersionId:   string;
  frameioFileId:    string;
}

function collectTargets(filterProjectId: string | null): BackfillTarget[] {
  const db = getCanonicalAssetDb();
  const rows = db.prepare(
    `SELECT a.project_id          AS projectId,
            av.asset_id           AS assetId,
            av.asset_version_id   AS assetVersionId,
            dr.provider_asset_id  AS frameioFileId
       FROM distribution_records dr
       JOIN asset_versions av ON av.asset_version_id = dr.asset_version_id
       JOIN assets        a  ON a.asset_id          = av.asset_id
      WHERE dr.provider = 'frameio'
        AND dr.provider_asset_id IS NOT NULL
        ${filterProjectId ? 'AND a.project_id = ?' : ''}
      ORDER BY a.project_id, av.created_at DESC`,
  ).all(...(filterProjectId ? [filterProjectId] : [])) as BackfillTarget[];
  return rows;
}

interface CommentAuthorJson {
  [commentId: string]: { name: string; userId: string };
}
interface CommentRepliesJson {
  [replyCommentId: string]: string;  // → parentCommentId (Frame.io id)
}

function readShim<T>(filePath: string): T {
  try {
    if (!fs.existsSync(filePath)) return {} as T;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return {} as T;
  }
}

interface ProjectShims {
  authors: CommentAuthorJson;
  replies: CommentRepliesJson;
}

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

function loadShims(projectId: string): ProjectShims {
  return {
    authors: readShim<CommentAuthorJson>(path.join(DATA_DIR, 'projects', projectId, 'comment-authors.json')),
    replies: readShim<CommentRepliesJson>(path.join(DATA_DIR, 'projects', projectId, 'comment-replies.json')),
  };
}

async function backfillOneAsset(
  target:  BackfillTarget,
  shims:   ProjectShims,
  dry:     boolean,
  verbose: boolean,
): Promise<{ fetched: number; inserted: number; skipped: number; errors: number }> {
  let fetched  = 0;
  let inserted = 0;
  let skipped  = 0;
  let errors   = 0;

  let comments: FrameIOComment[];
  try {
    comments = await getComments(target.frameioFileId);
  } catch (err) {
    console.warn(`  [skip] file ${target.frameioFileId}: ${(err as Error).message}`);
    return { fetched: 0, inserted: 0, skipped: 0, errors: 1 };
  }
  fetched = comments.length;

  // Walk comments top-level first; replies in the parents' arrays already
  // come from `getComments` (assembled via the comment-replies.json shim
  // server-side). Flatten so backfill produces one local row per Frame.io
  // comment id.
  const flat: Array<{ c: FrameIOComment; parentFrameioId: string | null }> = [];
  for (const c of comments) {
    flat.push({ c, parentFrameioId: null });
    for (const r of c.replies) {
      // Reply objects from getComments are the FrameIOCommentReply shape — no
      // timestamp/duration/completed/replies. Synthesize a comment-like shape
      // for the insert.
      const replyAsComment: FrameIOComment = {
        id:           r.id,
        text:         r.text,
        timestamp:    null,
        duration:     null,
        authorName:   r.authorName,
        authorAvatar: r.authorAvatar,
        createdAt:    r.createdAt,
        completed:    false,
        replies:      [],
      };
      flat.push({ c: replyAsComment, parentFrameioId: c.id });
    }
  }

  for (const { c, parentFrameioId } of flat) {
    // Skip the echoes: anything already in our local table.
    const existing = getMediaCommentByFrameioId(c.id);
    if (existing) {
      skipped++;
      if (verbose) console.log(`  [skip] already exists: ${c.id}`);
      continue;
    }

    if (dry) {
      inserted++;
      continue;
    }

    try {
      // Author shim: if this LPOS instance has a `comment-authors.json` entry
      // for this comment id, the row gets `author_user_id` set so the eventual
      // Phase 1 read path can attribute it correctly.
      const authorEntry = shims.authors[c.id];

      // Resolve parent's LOCAL comment_id from the Frame.io parent id. Top-
      // level inserts pass null. Replies look up via the same Frame.io-id
      // index — works because we insert parents before replies (the flat[]
      // ordering guarantees this).
      let parentLocalCommentId: string | null = null;
      if (parentFrameioId) {
        const parent = getMediaCommentByFrameioId(parentFrameioId);
        parentLocalCommentId = parent?.commentId ?? null;
      }

      insertMediaComment({
        projectId:           target.projectId,
        assetId:             target.assetId,
        assetVersionId:      target.assetVersionId,
        parentCommentId:     parentLocalCommentId,
        body:                c.text,
        timestampSeconds:    c.timestamp,                          // already NDF seconds in FrameIOComment shape
        durationSeconds:     c.duration,
        authorUserId:        authorEntry?.userId ?? null,
        authorExternalName:  authorEntry ? null : c.authorName,    // when LPOS authored, prefer LPOS user id; external name only for external reviewers
        authorAvatarUrl:     c.authorAvatar,
        source:              'frameio',                            // backfilled from Frame.io regardless of original poster
        frameioCommentId:    c.id,
        frameioFileId:       target.frameioFileId,
        completed:           c.completed,
        createdAtOverride:   c.createdAt,
      });
      inserted++;
      if (verbose) console.log(`  [insert] ${c.id} ${parentFrameioId ? '(reply)' : ''} — ${c.text.slice(0, 60)}`);
    } catch (err) {
      errors++;
      console.warn(`  [error] ${c.id}: ${(err as Error).message}`);
    }
  }

  return { fetched, inserted, skipped, errors };
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`[backfill-media-comments] starting${args.dry ? ' (DRY RUN — no writes)' : ''}${args.projectId ? ` (project=${args.projectId})` : ''}`);

  const targets = collectTargets(args.projectId);
  console.log(`[backfill-media-comments] ${targets.length} Frame.io-tracked asset versions to scan`);
  if (targets.length === 0) {
    console.log('[backfill-media-comments] nothing to do');
    return;
  }

  // Group targets by project so we load the JSON shims once per project.
  const byProject = new Map<string, BackfillTarget[]>();
  for (const t of targets) {
    const arr = byProject.get(t.projectId) ?? [];
    arr.push(t);
    byProject.set(t.projectId, arr);
  }

  let totalFetched  = 0;
  let totalInserted = 0;
  let totalSkipped  = 0;
  let totalErrors   = 0;
  let assetsProcessed = 0;

  for (const [projectId, projectTargets] of byProject) {
    const shims = loadShims(projectId);
    const authorShimCount = Object.keys(shims.authors).length;
    const replyShimCount  = Object.keys(shims.replies).length;
    console.log(`\n[project ${projectId}] ${projectTargets.length} versions; shims: ${authorShimCount} authors, ${replyShimCount} reply parents`);

    for (const target of projectTargets) {
      const result = await backfillOneAsset(target, shims, args.dry, args.verbose);
      totalFetched  += result.fetched;
      totalInserted += result.inserted;
      totalSkipped  += result.skipped;
      totalErrors   += result.errors;
      assetsProcessed++;

      if (result.fetched > 0 || result.errors > 0) {
        console.log(
          `  asset ${target.assetId} v=${target.assetVersionId.slice(0, 8)}: ` +
          `fetched ${result.fetched}, inserted ${result.inserted}, skipped ${result.skipped}, errors ${result.errors}`,
        );
      }
    }
  }

  console.log('\n[backfill-media-comments] DONE');
  console.log(`  assets processed: ${assetsProcessed}/${targets.length}`);
  console.log(`  comments fetched: ${totalFetched}`);
  console.log(`  comments inserted: ${totalInserted}${args.dry ? ' (would have been)' : ''}`);
  console.log(`  comments skipped (already existed): ${totalSkipped}`);
  console.log(`  errors: ${totalErrors}`);
}

main().catch((err) => {
  console.error('[backfill-media-comments] FATAL:', err);
  process.exit(1);
});
