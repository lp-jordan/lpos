/**
 * B2MediaSyncService — Raw Footage Cold Storage
 *
 * Nightly cold-storage sync of local footage/media directories to a direct
 * Backblaze B2 bucket (individual S3 objects). NOT an LPOS application backup —
 * this is peace-of-mind cold storage for raw footage on active projects.
 *
 * Retention model (disappearance tracking):
 *   - Every night, walk each configured source directory and reconcile against
 *     the B2 bucket via a per-object tracking table (b2_cold_storage_objects).
 *   - File present in source: upsertSeen() — record last_seen_at = now,
 *     CLEAR missing_since if previously set (re-appearance resets the clock).
 *   - File missing from source: markMissing() — sets missing_since = now ONLY
 *     if it isn't already set. Subsequent nights don't reset it.
 *   - File missing for ≥ retainDays consecutive nights: delete from B2,
 *     stamp deleted_at on the tracking row (kept for audit, pruned at 90d).
 *
 * What this does NOT do:
 *   - It does not delete a B2 object just because its upload date is old.
 *     A file that's been in source for 6 months stays in cold storage
 *     for the full 6 months. Retention is measured from disappearance, not
 *     from upload.
 *
 * Sync strategy:
 *   1. List B2 objects → b2Map: { key → size }.
 *   2. Bootstrap any B2 object not yet tracked (e.g. uploaded before this
 *      service existed, or out-of-band) — INSERT OR IGNORE with last_seen_at
 *      pinned to epoch so it gets marked missing this run unless source
 *      visit confirms it.
 *   3. Walk each source dir; for each file:
 *        size matches B2 → skip upload, upsertSeen
 *        otherwise → upload (multipart via lib-storage), upsertSeen
 *   4. markMissingNotSeenSince(runStart) — single UPDATE; any tracked row
 *      whose last_seen_at predates this run gets missing_since stamped.
 *   5. listQueuedForDeletion(retainDays) → DELETE from B2 → markDeleted.
 *   6. pruneAudit() — opportunistic delete of deleted_at rows older than 90d.
 *
 * Schedule:
 *   Polls once per minute. Fires when the wall-clock hour matches the
 *   admin-configured sync_hour and hasn't already run today.
 *
 * Credentials (Doppler env vars — required):
 *   B2_MEDIA_ENDPOINT          — S3-compatible URL (e.g. https://s3.us-west-004.backblazeb2.com)
 *   B2_MEDIA_KEY_ID            — Application Key ID
 *   B2_MEDIA_APPLICATION_KEY   — Application Key (the secret)
 *   B2_MEDIA_BUCKET            — bucket name
 *
 * Operational knobs (admin-tunable, stored in b2_sync_config):
 *   syncDirs                   — absolute paths to walk and upload
 *   retainDays                 — consecutive nights missing before deletion
 *   syncHour                   — wall-clock hour (0–23) for the daily run
 *
 * Service reads these on every poll, so admin edits take effect within ~1
 * minute without restarting LPOS.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getB2SyncConfig } from '@/lib/store/b2-sync-config-store';
import { getCoreDb } from '@/lib/store/core-db';
import {
  upsertSeen,
  markDeleted,
  listQueuedForDeletion,
  getColdStorageStats,
  pruneAudit,
  type ColdStorageStats,
} from '@/lib/store/b2-cold-storage-store';

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR    = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const STATUS_FILE = path.join(DATA_DIR, 'b2-media-sync-status.json');
const POLL_MS     = 60_000; // check every minute
const EPOCH_ISO   = '1970-01-01T00:00:00.000Z';

export function isB2MediaConfigured(): boolean {
  return !!(
    process.env.B2_MEDIA_ENDPOINT &&
    process.env.B2_MEDIA_KEY_ID &&
    process.env.B2_MEDIA_APPLICATION_KEY &&
    process.env.B2_MEDIA_BUCKET
  );
}

function makeClient(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.B2_MEDIA_ENDPOINT!,
    credentials: {
      accessKeyId:     process.env.B2_MEDIA_KEY_ID!,
      secretAccessKey: process.env.B2_MEDIA_APPLICATION_KEY!,
    },
  });
}

function getBucket(): string {
  return process.env.B2_MEDIA_BUCKET ?? '';
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface B2SyncError {
  key:   string;
  error: string;
}

/** Persisted after each run — summary only, not per-file success list. */
export interface B2SyncRunResult {
  timestamp:    string;
  dirs:         string[];
  uploaded:     number;
  skipped:      number;
  failed:       number;
  newlyMissing: number;   // files marked missing for the first time this run
  deleted:      number;   // B2 objects retired this run (retainDays elapsed)
  errors:       B2SyncError[];
  stats:        ColdStorageStats; // snapshot at end of run
}

/** Returned by getStatus() — includes live state layered over last run. */
export interface B2SyncStatus {
  configured:   boolean;
  running:      boolean;
  nextRunHour:  number;
  syncDirs:     string[];
  retainDays:   number;
  lastRun:      B2SyncRunResult | null;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class B2MediaSyncService {
  private timer:       ReturnType<typeof setInterval> | null = null;
  private lastRunDate: string | null = null;
  private isRunning    = false;

  start(): void {
    if (this.timer) return;

    if (!isB2MediaConfigured()) {
      console.log('[B2MediaSync] credentials not configured — service idle');
      return;
    }

    // We always start the timer once creds are present — sync_dirs can be
    // edited in admin settings (or the server app) at any time and the next
    // tick picks it up.
    const cfg = getB2SyncConfig();
    if (cfg.syncDirs.length === 0) {
      console.log('[B2MediaSync] no source dirs configured yet — polling will pick up changes');
    } else {
      console.log(`[B2MediaSync] starting — sync hour ${cfg.syncHour}, retain ${cfg.retainDays} days, dirs: ${cfg.syncDirs.join(', ')}`);
    }
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  private tick(): void {
    const cfg   = getB2SyncConfig();
    if (cfg.syncDirs.length === 0) return;        // nothing to do yet
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() === cfg.syncHour && this.lastRunDate !== today) {
      this.lastRunDate = today; // mark before async to prevent double-fire
      void this.runSync();
    }
  }

  // ── Core sync ──────────────────────────────────────────────────────────────

  async runSync(): Promise<B2SyncRunResult> {
    if (this.isRunning) {
      console.log('[B2MediaSync] already running — skipped');
      return this.loadLastRun() ?? this.emptyResult();
    }

    this.isRunning = true;
    const runStart  = new Date();
    const timestamp = runStart.toISOString();
    const cfg       = getB2SyncConfig();
    const dirs      = cfg.syncDirs;
    const client    = makeClient();
    const bucket    = getBucket();

    console.log(`[B2MediaSync] starting sync — ${dirs.length} source dir(s), retain ${cfg.retainDays} days`);

    let uploaded = 0, skipped = 0, failed = 0;
    const errors: B2SyncError[] = [];

    try {
      // 1. Build a key→size map of every existing B2 object
      const b2Objects = new Map<string, number>();
      let token: string | undefined;
      do {
        const res = await client.send(new ListObjectsV2Command({
          Bucket:            bucket,
          ContinuationToken: token,
        }));
        for (const obj of res.Contents ?? []) {
          if (obj.Key != null) b2Objects.set(obj.Key, obj.Size ?? 0);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);

      console.log(`[B2MediaSync] ${b2Objects.size} existing object(s) in bucket`);

      // 2. Bootstrap: any B2 object not yet tracked gets a row with
      //    last_seen_at pinned to epoch. Step 4 will mark them missing unless
      //    the source-walk in step 3 visits them first.
      bootstrapUntracked(b2Objects, timestamp);

      // 3. Walk each source directory
      for (const srcDir of dirs) {
        const topPrefix  = path.basename(srcDir) + '/'; // e.g. "Projects/"
        const localFiles = await collectFiles(srcDir);

        for (const absPath of localFiles) {
          const relPath = path.relative(srcDir, absPath).replace(/\\/g, '/');
          const key     = topPrefix + relPath;

          let stat: fs.Stats;
          try {
            stat = fs.statSync(absPath);
          } catch (err) {
            errors.push({ key, error: (err as Error).message });
            failed++;
            continue;
          }

          // Skip upload if B2 already has this file at the same size
          if (b2Objects.has(key) && b2Objects.get(key) === stat.size) {
            skipped++;
            upsertSeen(key, stat.size, timestamp);
            continue;
          }

          // Upload — @aws-sdk/lib-storage handles multipart automatically
          try {
            const upload = new Upload({
              client,
              params: {
                Bucket:      bucket,
                Key:         key,
                Body:        fs.createReadStream(absPath),
                ContentType: 'application/octet-stream',
              },
              queueSize:         4,                  // 4 concurrent parts
              partSize:          100 * 1024 * 1024,  // 100 MB per part
              leavePartsOnError: false,
            });
            await upload.done();
            uploaded++;
            upsertSeen(key, stat.size, timestamp);
            console.log(`[B2MediaSync] uploaded ${key} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
          } catch (err) {
            errors.push({ key, error: (err as Error).message });
            failed++;
            console.error(`[B2MediaSync] failed ${key}: ${(err as Error).message}`);
          }
        }
      }
    } catch (err) {
      console.error(`[B2MediaSync] fatal sync error: ${(err as Error).message}`);
    }

    // 4. Anything in the tracking table that wasn't touched this run is now
    //    missing — stamp missing_since on every such row (idempotent: skips
    //    rows that already have it).
    const newlyMissing = markMissingNotSeenSince(timestamp);

    // 5. Retention sweep — actually delete B2 objects whose missing_since
    //    has aged past retainDays.
    const queued = listQueuedForDeletion(cfg.retainDays, runStart);
    let deleted = 0;
    for (const obj of queued) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.key }));
        markDeleted(obj.key, timestamp);
        deleted++;
        console.log(`[B2MediaSync] retired ${obj.key} (missing since ${obj.missingSince})`);
      } catch (err) {
        errors.push({ key: obj.key, error: `delete failed: ${(err as Error).message}` });
        console.warn(`[B2MediaSync] delete failed ${obj.key}: ${(err as Error).message}`);
      }
    }

    // 6. Audit-history sweep — pure SQL bookkeeping, no B2 calls
    pruneAudit(runStart);

    const stats = getColdStorageStats(cfg.retainDays, runStart);

    const result: B2SyncRunResult = {
      timestamp, dirs, uploaded, skipped, failed, newlyMissing, deleted, errors, stats,
    };

    this.isRunning = false;
    this.saveLastRun(result);
    console.log(`[B2MediaSync] done — ${uploaded} up, ${skipped} skip, ${failed} fail, ${newlyMissing} newly missing, ${deleted} retired`);
    return result;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus(): B2SyncStatus {
    const cfg = getB2SyncConfig();
    return {
      configured:  isB2MediaConfigured(),
      running:     this.isRunning,
      nextRunHour: cfg.syncHour,
      syncDirs:    cfg.syncDirs,
      retainDays:  cfg.retainDays,
      lastRun:     this.loadLastRun(),
    };
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private saveLastRun(result: B2SyncRunResult): void {
    try {
      fs.writeFileSync(STATUS_FILE, JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[B2MediaSync] could not save status: ${(err as Error).message}`);
    }
  }

  private loadLastRun(): B2SyncRunResult | null {
    try {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) as B2SyncRunResult;
    } catch {
      return null;
    }
  }

  private emptyResult(): B2SyncRunResult {
    return {
      timestamp:    new Date().toISOString(),
      dirs:         [],
      uploaded:     0, skipped: 0, failed: 0,
      newlyMissing: 0, deleted: 0,
      errors:       [],
      stats:        {
        activeObjects: 0, activeBytes: 0, missingObjects: 0,
        queuedForDelete: 0, deletedHistory: 0,
      },
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all files under dir, skipping dot-prefixed entries. */
async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

/**
 * Insert a tracking row for any B2 object we haven't seen before. last_seen_at
 * is pinned to the epoch so that step 4 (markMissingNotSeenSince) will stamp
 * missing_since for any of these that the source-walk doesn't visit.
 * INSERT OR IGNORE is intentional — existing rows are left alone (their state
 * is whatever previous syncs established).
 */
function bootstrapUntracked(b2Objects: Map<string, number>, runStart: string): void {
  const stmt = getCoreDb().prepare(`
    INSERT OR IGNORE INTO b2_cold_storage_objects
      (key, size, uploaded_at, last_seen_at, missing_since, deleted_at)
    VALUES (?, ?, ?, ?, NULL, NULL)
  `);
  for (const [key, size] of b2Objects) {
    stmt.run(key, size, runStart, EPOCH_ISO);
  }
}

/**
 * Stamp missing_since on every active tracking row whose last_seen_at predates
 * the current run. Idempotent — rows that already have missing_since set are
 * not touched (we don't reset the clock just because another night confirmed
 * the file is still gone).
 * Returns the count of rows newly stamped this run.
 */
function markMissingNotSeenSince(runStart: string): number {
  const res = getCoreDb()
    .prepare(`
      UPDATE b2_cold_storage_objects
         SET missing_since = ?
       WHERE deleted_at IS NULL
         AND missing_since IS NULL
         AND last_seen_at < ?
    `)
    .run(runStart, runStart);
  return Number(res.changes ?? 0);
}
