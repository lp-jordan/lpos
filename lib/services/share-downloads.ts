/**
 * Share downloads — keeps R2 holding exactly the files clients can download.
 *
 * A share with Download on offers every video as Original (the LPOS export
 * file) and Web (a 1080p H.264 copy LPOS encodes), plus transcripts, all served
 * from R2 (free egress) — never from LPOS's disk. Files are stored once per
 * asset VERSION and reused by every share that offers that video.
 *
 * A reconcile pass (every 20s, or on demand via kickShareDownloads) does:
 *   1. Expiry — a share whose "downloads until" has passed switches Download off.
 *   2. Want-list — the newest cut of every video in a share with Download on.
 *   3. Purge — R2 files no share wants are deleted after a 3-day grace (from
 *      Download off / video removed / share revoked). A superseded cut goes 3
 *      days after the new cut's files are ready.
 *   4. Work — missing files are made one at a time: original → web → transcripts,
 *      mirrored into the Upload Tray when the upload queue is running.
 *
 * Runs wherever the LPOS server runs (the machine with the files); uploads are
 * outbound only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { getAsset } from '@/lib/store/media-registry';
import { listAssetVersionsWithFrameioFileId } from '@/lib/store/canonical-asset-store';
import { DOWNLOAD_DAYS, getShareLinksDb } from '@/lib/store/share-links-db';
import {
  SHARE_DOWNLOADS_PREFIX,
  deleteR2Object,
  encodeWebCopy,
  isShareR2Configured,
  mimeForExt,
  uploadFileToR2,
} from '@/lib/services/share-r2';

export const DOWNLOAD_GRACE_MS = 3 * 86_400_000;
const TICK_MS = 20_000;
const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

export type DownloadKind = 'original' | 'web' | 'srt' | 'vtt' | 'txt';
const TRANSCRIPT_KINDS: DownloadKind[] = ['srt', 'vtt', 'txt'];

interface FileRow {
  asset_version_id: string; kind: DownloadKind; asset_id: string; project_id: string;
  r2_key: string | null; ext: string | null; size: number | null;
  status: 'pending' | 'working' | 'ready' | 'failed'; progress: number; error: string | null;
  created_at: string; updated_at: string; ready_at: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __lpos_share_downloads: { timer: ReturnType<typeof setInterval> | null; busy: boolean; again: boolean; proc: ChildProcess | null } | undefined;
}
function state() {
  globalThis.__lpos_share_downloads ??= { timer: null, busy: false, again: false, proc: null };
  return globalThis.__lpos_share_downloads;
}

/** Start the background pass (idempotent). server.ts boot and the share API both call this. */
export function ensureShareDownloadWorker(): void {
  const st = state();
  if (st.timer) return;
  // Anything mid-flight when the server stopped starts over.
  getShareLinksDb().prepare("UPDATE share_download_files SET status = 'pending', progress = 0 WHERE status = 'working'").run();
  st.timer = setInterval(() => void reconcile(), TICK_MS);
  void reconcile();
}

/** Run a pass now (after a share's Download switch or video list changes). */
export function kickShareDownloads(): void {
  ensureShareDownloadWorker();
  void reconcile();
}

// ── Want-list ────────────────────────────────────────────────────────────────

interface Wanted { assetId: string; projectId: string }

function wantedAndGrace(now: number): { wanted: Map<string, Wanted>; grace: Set<string> } {
  const db = getShareLinksDb();
  const shares = db.prepare('SELECT id, caps, revoked_at, downloads_off_at FROM share_links').all() as Array<{ id: string; caps: string; revoked_at: string | null; downloads_off_at: string | null }>;
  const items = db.prepare('SELECT share_id, asset_id, project_id, in_list, removed_at FROM share_link_items').all() as Array<{ share_id: string; asset_id: string; project_id: string; in_list: number; removed_at: string | null }>;
  const recent = (iso: string | null) => !!iso && now - new Date(iso).getTime() < DOWNLOAD_GRACE_MS;

  const wanted = new Map<string, Wanted>();
  const grace = new Set<string>();
  const byId = new Map(shares.map((s) => [s.id, s]));
  for (const it of items) {
    const s = byId.get(it.share_id);
    if (!s) continue;
    let download = false;
    try { download = !!(JSON.parse(s.caps) as { download?: boolean }).download; } catch { /* off */ }
    const live = !s.revoked_at && download;
    if (live && it.in_list) { wanted.set(it.asset_id, { assetId: it.asset_id, projectId: it.project_id }); continue; }
    // Recently stopped being offered → keep files through the grace period.
    if (recent(s.revoked_at) || (!download && recent(s.downloads_off_at)) || (!it.in_list && recent(it.removed_at))) grace.add(it.asset_id);
  }
  return { wanted, grace };
}

function latestVersionId(assetId: string): string | null {
  return listAssetVersionsWithFrameioFileId(assetId)[0]?.assetVersionId ?? null;
}

function transcriptPath(projectId: string, jobId: string, kind: DownloadKind): string {
  return kind === 'vtt'
    ? path.join(DATA_DIR, 'projects', projectId, 'subtitles', `${jobId}.vtt`)
    : path.join(DATA_DIR, 'projects', projectId, 'transcripts', `${jobId}.${kind}`);
}

// ── Reconcile ────────────────────────────────────────────────────────────────

async function reconcile(): Promise<void> {
  const st = state();
  if (st.busy) { st.again = true; return; }
  st.busy = true;
  try {
    do {
      st.again = false;
      await pass();
    } while (st.again);
  } catch (err) {
    console.warn('[share-downloads] pass failed:', (err as Error).message);
  } finally {
    st.busy = false;
  }
}

async function pass(): Promise<void> {
  const db = getShareLinksDb();
  const now = Date.now();
  const iso = new Date(now).toISOString();

  // 0. A share with Download on but no expiry (made before expiry existed) gets the standard window.
  for (const s of db.prepare('SELECT id, caps FROM share_links WHERE revoked_at IS NULL AND downloads_until IS NULL').all() as Array<{ id: string; caps: string }>) {
    let on = false;
    try { on = !!(JSON.parse(s.caps) as { download?: boolean }).download; } catch { /* off */ }
    if (on) db.prepare('UPDATE share_links SET downloads_until = ? WHERE id = ?').run(new Date(now + DOWNLOAD_DAYS * 86_400_000).toISOString(), s.id);
  }

  // 1. Expiry: Download switches itself off; the grace clock starts at the expiry moment.
  const expiring = db.prepare(
    `SELECT id, caps, downloads_until FROM share_links
      WHERE revoked_at IS NULL AND downloads_until IS NOT NULL AND downloads_until <= ?`,
  ).all(iso) as Array<{ id: string; caps: string; downloads_until: string }>;
  for (const s of expiring) {
    const caps = JSON.parse(s.caps) as Record<string, boolean>;
    if (!caps.download) continue;
    caps.download = false;
    db.prepare('UPDATE share_links SET caps = ?, downloads_off_at = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(caps), s.downloads_until, iso, s.id);
    console.log(`[share-downloads] downloads expired for share ${s.id}`);
  }

  const { wanted, grace } = wantedAndGrace(now);

  // 2. Make sure every wanted video's newest cut has its rows.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO share_download_files (asset_version_id, kind, asset_id, project_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  );
  const latestOf = new Map<string, string>();
  for (const w of wanted.values()) {
    const versionId = latestVersionId(w.assetId);
    const asset = getAsset(w.projectId, w.assetId);
    if (!versionId || !asset?.filePath) continue;
    latestOf.set(w.assetId, versionId);
    insert.run(versionId, 'original', w.assetId, w.projectId, iso, iso);
    insert.run(versionId, 'web', w.assetId, w.projectId, iso, iso);
    const tx = asset.transcription?.status === 'done' ? asset.transcription.jobId : null;
    if (tx) for (const k of TRANSCRIPT_KINDS) if (fs.existsSync(transcriptPath(w.projectId, tx, k))) insert.run(versionId, k, w.assetId, w.projectId, iso, iso);
  }

  // 3. Purge what no share needs any more.
  const rows = db.prepare('SELECT * FROM share_download_files').all() as unknown as FileRow[];
  for (const r of rows) {
    const isWanted = wanted.has(r.asset_id);
    const latest = latestOf.get(r.asset_id) ?? (isWanted || grace.has(r.asset_id) ? latestVersionId(r.asset_id) : null);
    let drop = false;
    if (!isWanted && !grace.has(r.asset_id)) drop = true;
    else if (latest && r.asset_version_id !== latest) {
      // Superseded cut: keep until the new cut's original + web have been ready for the grace period.
      const fresh = db.prepare(
        "SELECT MAX(ready_at) AS r, COUNT(*) AS n FROM share_download_files WHERE asset_version_id = ? AND kind IN ('original','web') AND status = 'ready'",
      ).get(latest) as { r: string | null; n: number };
      if (fresh.n === 2 && fresh.r && now - new Date(fresh.r).getTime() >= DOWNLOAD_GRACE_MS) drop = true;
      if (!isWanted) drop = true;   // only kept in grace for its newest cut
    }
    if (!drop) continue;
    if (r.status === 'working') continue;   // let the running job finish; the next pass cleans up
    try {
      if (r.r2_key) await deleteR2Object(r.r2_key);
      db.prepare('DELETE FROM share_download_files WHERE asset_version_id = ? AND kind = ?').run(r.asset_version_id, r.kind);
      if (r.r2_key) console.log(`[share-downloads] purged ${r.r2_key}`);
    } catch (err) {
      console.warn(`[share-downloads] purge failed for ${r.r2_key}:`, (err as Error).message);
    }
  }

  // 4. Make the next missing file (one per pass; the loop repeats while there's work).
  if (!isShareR2Configured()) return;
  const next = db.prepare(
    `SELECT * FROM share_download_files WHERE status = 'pending'
      ORDER BY CASE kind WHEN 'original' THEN 0 WHEN 'web' THEN 1 ELSE 2 END, created_at LIMIT 1`,
  ).get() as unknown as FileRow | undefined;
  if (!next) return;
  if (latestOf.get(next.asset_id) !== next.asset_version_id) {
    // No longer the newest cut (or no longer wanted) — the purge step will remove it.
    db.prepare("UPDATE share_download_files SET status = 'failed', error = 'Superseded' WHERE asset_version_id = ? AND kind = ?").run(next.asset_version_id, next.kind);
    state().again = true;
    return;
  }
  await makeFile(next);
  state().again = true;
}

// ── Making one file ──────────────────────────────────────────────────────────

/** Structural slice of UploadQueueService — optional (not running in UI-only dev). */
interface Queue {
  add(projectId: string, assetId: string, filename: string, provider: 'delivery'): string;
  setProgress(jobId: string, progress: number, detail?: string): void;
  heartbeat(jobId: string): void;
  complete(jobId: string): void;
  fail(jobId: string, error: string): void;
}
async function uploadQueue(): Promise<Queue | null> {
  try {
    const { getUploadQueueService } = await import('@/lib/services/container');
    return getUploadQueueService() as unknown as Queue;
  } catch { return null; }
}

async function makeFile(r: FileRow): Promise<void> {
  const db = getShareLinksDb();
  const set = (fields: Partial<FileRow>) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE share_download_files SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE asset_version_id = ? AND kind = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k] as never), new Date().toISOString(), r.asset_version_id, r.kind);
  };
  const asset = getAsset(r.project_id, r.asset_id);
  if (!asset?.filePath || !fs.existsSync(asset.filePath)) {
    set({ status: 'failed', error: 'The file is not on disk' });
    return;
  }
  const base = `${SHARE_DOWNLOADS_PREFIX}/${r.asset_id}/${r.asset_version_id}`;
  const label = asset.name || asset.originalFilename;
  const queue = r.kind === 'original' || r.kind === 'web' ? await uploadQueue() : null;
  const jobId = queue?.add(r.project_id, r.asset_id, `${label} — ${r.kind === 'web' ? 'web copy' : 'original'} for download`, 'delivery') ?? null;
  const progress = (pct: number, detail?: string) => {
    set({ progress: pct });
    if (jobId) queue!.setProgress(jobId, pct, detail);
  };
  set({ status: 'working', progress: 0, error: null });

  try {
    if (r.kind === 'original') {
      const ext = path.extname(asset.filePath).toLowerCase() || '.mp4';
      const key = `${base}/original${ext}`;
      const size = fs.statSync(asset.filePath).size;
      await uploadFileToR2(key, asset.filePath, mimeForExt(ext), (loaded) => progress(Math.min(99, Math.round((loaded / Math.max(1, size)) * 100)), 'Uploading original'));
      set({ status: 'ready', progress: 100, r2_key: key, ext, size, ready_at: new Date().toISOString() });
    } else if (r.kind === 'web') {
      const tmp = path.join(os.tmpdir(), `lpos-share-web-${r.asset_version_id}.mp4`);
      const beat = jobId ? setInterval(() => queue!.heartbeat(jobId), 60_000) : null;
      progress(5, 'Encoding web copy');
      try {
        await encodeWebCopy(asset.filePath, tmp, (p) => { state().proc = p; });
      } finally {
        state().proc = null;
        if (beat) clearInterval(beat);
      }
      const key = `${base}/web.mp4`;
      const size = fs.statSync(tmp).size;
      try {
        await uploadFileToR2(key, tmp, 'video/mp4', (loaded) => progress(50 + Math.min(49, Math.round((loaded / Math.max(1, size)) * 50)), 'Uploading web copy'));
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      set({ status: 'ready', progress: 100, r2_key: key, ext: '.mp4', size, ready_at: new Date().toISOString() });
    } else {
      const tx = asset.transcription?.status === 'done' ? asset.transcription.jobId : null;
      const src = tx ? transcriptPath(r.project_id, tx, r.kind) : null;
      if (!src || !fs.existsSync(src)) { set({ status: 'failed', error: 'No transcript file' }); return; }
      const key = `${base}/transcript.${r.kind}`;
      await uploadFileToR2(key, src, mimeForExt(`.${r.kind}`));
      set({ status: 'ready', progress: 100, r2_key: key, ext: `.${r.kind}`, size: fs.statSync(src).size, ready_at: new Date().toISOString() });
    }
    if (jobId) queue!.complete(jobId);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[share-downloads] ${r.kind} for ${r.asset_id} failed:`, message);
    set({ status: 'failed', error: message.slice(0, 500) });
    if (jobId) queue!.fail(jobId, message);
  }
}

/** Retry failed files for these assets (e.g. after a file comes back on disk). */
export function retryFailedDownloads(assetIds: string[]): void {
  const db = getShareLinksDb();
  for (const id of assetIds) db.prepare("UPDATE share_download_files SET status = 'pending', error = NULL WHERE asset_id = ? AND status = 'failed' AND error != 'Superseded'").run(id);
  kickShareDownloads();
}

// ── Status for the UI ────────────────────────────────────────────────────────

export interface AssetDownloadStatus {
  /** preparing: still being made · ready: original + web available · failed · none: not offered */
  state: 'none' | 'preparing' | 'ready' | 'failed';
  original: { size: number; ext: string } | null;
  web: { size: number } | null;
  transcripts: Array<'srt' | 'vtt' | 'txt'>;
  error: string | null;
  progress: number;
}

export function downloadStatusFor(assetId: string): AssetDownloadStatus {
  const versionId = latestVersionId(assetId);
  const none: AssetDownloadStatus = { state: 'none', original: null, web: null, transcripts: [], error: null, progress: 0 };
  if (!versionId) return none;
  const rows = getShareLinksDb().prepare('SELECT * FROM share_download_files WHERE asset_version_id = ?').all(versionId) as unknown as FileRow[];
  if (!rows.length) return none;
  const by = new Map(rows.map((r) => [r.kind, r]));
  const o = by.get('original'); const w = by.get('web');
  const ready = (r?: FileRow) => r?.status === 'ready';
  const failed = [o, w].find((r) => r?.status === 'failed');
  return {
    state: ready(o) && ready(w) ? 'ready' : failed ? 'failed' : 'preparing',
    original: ready(o) ? { size: o!.size ?? 0, ext: o!.ext ?? '' } : null,
    web: ready(w) ? { size: w!.size ?? 0 } : null,
    transcripts: TRANSCRIPT_KINDS.filter((k) => ready(by.get(k))) as Array<'srt' | 'vtt' | 'txt'>,
    error: failed?.error ?? null,
    progress: Math.round(((o?.progress ?? 0) + (w?.progress ?? 0)) / 2),
  };
}

/** The R2 object for one downloadable file of a video's newest cut, if ready. */
export function readyDownloadFile(assetId: string, kind: DownloadKind): { key: string; ext: string; size: number } | null {
  const versionId = latestVersionId(assetId);
  if (!versionId) return null;
  const r = getShareLinksDb().prepare("SELECT * FROM share_download_files WHERE asset_version_id = ? AND kind = ? AND status = 'ready'").get(versionId, kind) as unknown as FileRow | undefined;
  return r?.r2_key ? { key: r.r2_key, ext: r.ext ?? '', size: r.size ?? 0 } : null;
}
