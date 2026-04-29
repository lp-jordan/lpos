/**
 * BackupService
 *
 * Nightly backup of all SQLite databases to Cloudflare R2.
 * Falls back to a local data/backups/ directory when R2 env vars are absent.
 *
 * Safe copy strategy: VACUUM INTO '/tmp/…' produces a defragmented,
 * fully consistent snapshot while the source DB is live. The snapshot is
 * then gzip-compressed in memory and uploaded (or written locally).
 *
 * Schedule:
 *  - Runs once ~30 s after start() to validate config on first boot.
 *  - Repeats every 24 h thereafter.
 *
 * Required env vars (R2 mode):
 *   R2_BACKUP_BUCKET              — bucket name
 *   R2_BACKUP_ACCESS_KEY_ID       — R2 access key
 *   R2_BACKUP_SECRET_ACCESS_KEY   — R2 secret key
 *   CLOUDFLARE_ACCOUNT_ID         — used to build the R2 endpoint URL
 *
 * Optional:
 *   LPOS_BACKUP_RETAIN_DAYS       — days to keep; default 7
 *   LPOS_DATA_DIR                 — data directory; default <cwd>/data
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BackupFileResult {
  db:       string;
  ok:       boolean;
  bytes?:   number;
  error?:   string;
}

export interface BackupResult {
  timestamp:  string;
  target:     'r2' | 'local';
  files:      BackupFileResult[];
  swept:      number;    // old backup entries deleted
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const RETAIN_DAYS = parseInt(process.env.LPOS_BACKUP_RETAIN_DAYS ?? '7', 10);
const INTERVAL_MS = 24 * 60 * 60 * 1_000; // 24 h
const FIRST_RUN_DELAY_MS = 90_000;         // 90 s after start() — lets Drive scan finish first

function getR2Client(): S3Client | null {
  const accountId  = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKey  = process.env.R2_BACKUP_ACCESS_KEY_ID;
  const secretKey  = process.env.R2_BACKUP_SECRET_ACCESS_KEY;
  const bucket     = process.env.R2_BACKUP_BUCKET;
  if (!accountId || !accessKey || !secretKey || !bucket) return null;

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
}

function getR2Bucket(): string {
  return process.env.R2_BACKUP_BUCKET ?? '';
}

async function vacuumInto(dbPath: string, tmpPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.prepare(`VACUUM INTO ?`).run(tmpPath);
  } finally {
    db.close();
  }
}

function gzipBuffer(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gzip(buf, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function todayPrefix(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function cutoffDate(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

// ── BackupService ─────────────────────────────────────────────────────────────

export class BackupService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstRunTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.timer) return; // already started

    this.firstRunTimer = setTimeout(() => {
      void this.runBackup();
    }, FIRST_RUN_DELAY_MS);

    this.timer = setInterval(() => {
      void this.runBackup();
    }, INTERVAL_MS);
  }

  stop(): void {
    if (this.firstRunTimer) { clearTimeout(this.firstRunTimer);  this.firstRunTimer = null; }
    if (this.timer)         { clearInterval(this.timer);         this.timer = null; }
  }

  async runBackup(): Promise<BackupResult> {
    const timestamp = new Date().toISOString();
    const dateKey   = todayPrefix();
    const r2        = getR2Client();
    const target: 'r2' | 'local' = r2 ? 'r2' : 'local';

    console.log(`[BackupService] starting backup — target: ${target}`);

    // Discover all .sqlite files in DATA_DIR
    let dbPaths: string[] = [];
    try {
      dbPaths = fs.readdirSync(DATA_DIR)
        .filter((f) => f.endsWith('.sqlite'))
        .map((f) => path.join(DATA_DIR, f));
    } catch (err) {
      console.warn(`[BackupService] cannot read data dir ${DATA_DIR}: ${(err as Error).message}`);
    }

    const files: BackupFileResult[] = [];

    for (const dbPath of dbPaths) {
      const dbName = path.basename(dbPath);
      const tmpPath = path.join(os.tmpdir(), `lpos-backup-${dbName}-${Date.now()}.sqlite`);
      try {
        // 1. Consistent copy via VACUUM INTO
        await vacuumInto(dbPath, tmpPath);

        // 2. Read + gzip
        const raw = await fsp.readFile(tmpPath);
        const gz  = await gzipBuffer(raw);

        const objectName = `backups/${dateKey}/${dbName}.gz`;

        if (r2) {
          // 3a. Upload to R2
          await r2.send(new PutObjectCommand({
            Bucket:      getR2Bucket(),
            Key:         objectName,
            Body:        gz,
            ContentType: 'application/gzip',
          }));
        } else {
          // 3b. Write to local fallback
          const localDir = path.join(DATA_DIR, 'backups', dateKey);
          fs.mkdirSync(localDir, { recursive: true });
          await fsp.writeFile(path.join(localDir, `${dbName}.gz`), gz);
        }

        files.push({ db: dbName, ok: true, bytes: gz.length });
        console.log(`[BackupService] backed up ${dbName} (${gz.length} bytes compressed)`);
      } catch (err) {
        files.push({ db: dbName, ok: false, error: (err as Error).message });
        console.error(`[BackupService] failed to back up ${dbName}: ${(err as Error).message}`);
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }

    // ── Retention sweep ────────────────────────────────────────────────────────
    let swept = 0;
    const cutoff = cutoffDate(RETAIN_DAYS);

    if (r2) {
      swept = await this.sweepR2(r2, cutoff);
    } else {
      swept = await this.sweepLocal(cutoff);
    }

    const result: BackupResult = { timestamp, target, files, swept };
    console.log(`[BackupService] backup complete — ${files.filter((f) => f.ok).length}/${files.length} ok, ${swept} old entries removed`);
    return result;
  }

  // ── Retention helpers ──────────────────────────────────────────────────────

  private async sweepR2(r2: S3Client, cutoff: Date): Promise<number> {
    let swept = 0;
    let continuationToken: string | undefined;

    try {
      do {
        const res = await r2.send(new ListObjectsV2Command({
          Bucket:            getR2Bucket(),
          Prefix:            'backups/',
          ContinuationToken: continuationToken,
        }));

        for (const obj of res.Contents ?? []) {
          if (!obj.Key || !obj.LastModified) continue;
          if (obj.LastModified < cutoff) {
            await r2.send(new DeleteObjectCommand({ Bucket: getR2Bucket(), Key: obj.Key }));
            swept++;
          }
        }

        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (err) {
      console.warn(`[BackupService] R2 retention sweep error: ${(err as Error).message}`);
    }

    return swept;
  }

  private async sweepLocal(cutoff: Date): Promise<number> {
    const backupsRoot = path.join(DATA_DIR, 'backups');
    let swept = 0;

    try {
      const dirs = fs.readdirSync(backupsRoot);
      for (const dir of dirs) {
        const dirPath = path.join(backupsRoot, dir);
        const stat = fs.statSync(dirPath);
        if (stat.isDirectory() && stat.mtime < cutoff) {
          await fsp.rm(dirPath, { recursive: true, force: true });
          swept++;
        }
      }
    } catch {
      // backups dir may not exist yet — ignore
    }

    return swept;
  }
}
