/**
 * B2MediaSyncService
 *
 * Nightly incremental sync of local footage/media directories to a direct
 * Backblaze B2 bucket (individual S3 objects — not HyperBackup format).
 *
 * Sync strategy:
 *   1. List all existing B2 objects and build a size-indexed map.
 *   2. Walk each configured source directory recursively.
 *   3. Upload any file missing from B2 or whose local size differs.
 *   4. After uploads, sweep objects older than RETAIN_DAYS.
 *
 * Size comparison is the incremental check — media files don't change
 * silently, so matching size means the upload is current.
 *
 * Uploads use @aws-sdk/lib-storage's Upload class which automatically
 * splits files into multipart chunks for large files (100 MB parts,
 * 4 concurrent). Suitable for multi-GB raw footage.
 *
 * Schedule:
 *   Polls once per minute. Fires when the wall-clock hour matches
 *   B2_MEDIA_SYNC_HOUR and hasn't already run today.
 *
 * Required env vars:
 *   B2_MEDIA_ENDPOINT          — S3-compatible URL (e.g. https://s3.us-west-004.backblazeb2.com)
 *   B2_MEDIA_KEY_ID            — Application Key ID
 *   B2_MEDIA_APPLICATION_KEY   — Application Key
 *   B2_MEDIA_BUCKET            — bucket name
 *   B2_MEDIA_SYNC_DIRS         — colon-separated absolute paths to sync
 *
 * Optional:
 *   B2_MEDIA_RETAIN_DAYS       — days to keep; default 30
 *   B2_MEDIA_SYNC_HOUR         — 24h hour to run (0–23); default 2 (2 AM)
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR     = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const RETAIN_DAYS  = parseInt(process.env.B2_MEDIA_RETAIN_DAYS ?? '30', 10);
const SYNC_HOUR    = parseInt(process.env.B2_MEDIA_SYNC_HOUR   ?? '2',  10);
const STATUS_FILE  = path.join(DATA_DIR, 'b2-media-sync-status.json');
const POLL_MS      = 60_000; // check every minute

function getSyncDirs(): string[] {
  return (process.env.B2_MEDIA_SYNC_DIRS ?? '')
    .split(':')
    .map((d) => d.trim())
    .filter(Boolean);
}

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
  timestamp: string;
  dirs:      string[];
  uploaded:  number;
  skipped:   number;
  failed:    number;
  swept:     number;
  errors:    B2SyncError[];
}

/** Returned by getStatus() — includes live state layered over last run. */
export interface B2SyncStatus {
  configured:  boolean;
  running:     boolean;
  nextRunHour: number;
  syncDirs:    string[];
  lastRun:     B2SyncRunResult | null;
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
    if (getSyncDirs().length === 0) {
      console.log('[B2MediaSync] B2_MEDIA_SYNC_DIRS not set — service idle');
      return;
    }

    console.log(`[B2MediaSync] starting — sync hour ${SYNC_HOUR}, retain ${RETAIN_DAYS} days, dirs: ${getSyncDirs().join(', ')}`);
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  private tick(): void {
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() === SYNC_HOUR && this.lastRunDate !== today) {
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
    const timestamp = new Date().toISOString();
    const dirs      = getSyncDirs();
    const client    = makeClient();
    const bucket    = getBucket();

    console.log(`[B2MediaSync] starting sync — ${dirs.length} dir(s)`);

    let uploaded = 0, skipped = 0, failed = 0;
    const errors: B2SyncError[] = [];

    try {
      // 1. Build a key→size map of every existing B2 object (O(1) lookup later)
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

      // 2. Walk each source directory
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

          // Skip if B2 already has this file at the same size
          if (b2Objects.has(key) && b2Objects.get(key) === stat.size) {
            skipped++;
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
              queueSize:         4,                // 4 concurrent parts
              partSize:          100 * 1024 * 1024, // 100 MB per part
              leavePartsOnError: false,
            });
            await upload.done();
            uploaded++;
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

    // 3. Retention sweep
    const swept = await this.sweep(client, bucket);

    const result: B2SyncRunResult = {
      timestamp, dirs, uploaded, skipped, failed, swept, errors,
    };

    this.isRunning = false;
    this.saveLastRun(result);
    console.log(`[B2MediaSync] done — ${uploaded} uploaded, ${skipped} skipped, ${failed} failed, ${swept} swept`);
    return result;
  }

  // ── Retention sweep ────────────────────────────────────────────────────────

  private async sweep(client: S3Client, bucket: string): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETAIN_DAYS);
    let swept = 0;
    try {
      let token: string | undefined;
      do {
        const res = await client.send(new ListObjectsV2Command({
          Bucket:            bucket,
          ContinuationToken: token,
        }));
        for (const obj of res.Contents ?? []) {
          if (obj.Key && obj.LastModified && obj.LastModified < cutoff) {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
            swept++;
            console.log(`[B2MediaSync] swept ${obj.Key}`);
          }
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
    } catch (err) {
      console.warn(`[B2MediaSync] sweep error: ${(err as Error).message}`);
    }
    return swept;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus(): B2SyncStatus {
    return {
      configured:  isB2MediaConfigured(),
      running:     this.isRunning,
      nextRunHour: SYNC_HOUR,
      syncDirs:    getSyncDirs(),
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
      timestamp: new Date().toISOString(),
      dirs:      [],
      uploaded:  0, skipped: 0, failed: 0, swept: 0,
      errors:    [],
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
