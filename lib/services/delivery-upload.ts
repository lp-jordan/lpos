// Shared delivery-link upload pipeline.
//
// A delivery link is a frozen snapshot: at build time the asset's *current*
// bytes are physically copied into R2 under `delivery/{token}/...` and the
// ingest server records those R2 keys. Nothing rewrites them afterwards, which
// is why an old link keeps serving an old cut until it is explicitly refreshed.
//
// This module owns the multi-phase copy job so all three entry points share one
// code path:
//   • create  (route.ts)          — new token, register creates the link + rows
//   • add     (assets/route.ts)    — existing token, register appends rows
//   • refresh (refresh/route.ts)   — existing token + existing keys, register
//                                    updates each row's size/version in place
//
// Phases (progress budget matches the original create job):
//   Phase A  1..56   upload originals (+ thumbnails) to R2
//   Register 58..62  persist rows on the ingest server (mode-specific callback)
//   Phase B  62..68  upload available transcripts per video
//   Phase C  68..100 transcode an H.264 proxy per video, upload, notify ingest

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import ffmpegPath from 'ffmpeg-static';
import type { MediaAsset } from '@/lib/models/media-asset';
import { getAsset } from '@/lib/store/media-registry';
import { activeDeliveryJobs, activeFfmpegProcs, killFfmpegProc } from '@/lib/services/delivery-job-registry';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';

export const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export const INGEST_URL     = (process.env.INGEST_BASE_URL ?? '').replace(/\/$/, '');
export const INGEST_API_KEY = process.env.INGEST_API_KEY!;
export const R2_BUCKET      = process.env.R2_BUCKET!;
export const DATA_DIR       = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

;['INGEST_BASE_URL', 'INGEST_API_KEY', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].forEach((k) => {
  if (!process.env[k]) console.error(`[delivery] ⚠ Missing env var: ${k}`);
});

const VIDEO_MIME_TYPES = new Set([
  'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
  'video/webm', 'video/mxf', 'video/m4v', 'video/mts',
]);

// The asset version a delivery item was built from — used to detect staleness
// ("this asset advanced since the link was made"). Mirrors cloudflare.isStale.
export function assetVersionOf(asset: MediaAsset): number {
  return asset.frameio.version ?? 1;
}

/** One R2-uploaded asset, as registered with the ingest server. */
export interface R2AssetRecord {
  r2_key:            string;
  filename:          string;
  file_size:         number;
  mime_type:         string;
  thumbnail_url?:    string;
  thumbnail_r2_key?: string;
  asset_id:          string;
  asset_version:     number;
}

export interface EligibleAsset {
  asset:    MediaAsset;
  /** Sanitized filename that drives the R2 key. For refresh, pass the *existing*
   *  item filename so the keys line up and the bytes overwrite in place. */
  filename: string;
}

/**
 * Resolve a set of asset IDs into deliverable (eligible) assets — those with a
 * local file on disk — and a list of the ineligible ones with a reason. Shared
 * by the create and add endpoints.
 */
export function resolveEligible(projectId: string, assetIds: string[]): {
  eligible:   EligibleAsset[];
  ineligible: { assetId: string; name: string; reason: string }[];
} {
  const eligible:   EligibleAsset[] = [];
  const ineligible: { assetId: string; name: string; reason: string }[] = [];

  for (const assetId of assetIds) {
    const asset = getAsset(projectId, assetId);
    if (!asset) {
      ineligible.push({ assetId, name: assetId, reason: 'Asset not found' });
      continue;
    }
    if (!asset.filePath) {
      ineligible.push({ assetId, name: asset.name, reason: 'No local file — may only exist on Frame.io' });
      continue;
    }
    if (!fs.existsSync(asset.filePath)) {
      ineligible.push({ assetId, name: asset.name, reason: 'File not found on disk' });
      continue;
    }
    eligible.push({ asset, filename: sanitize(asset.originalFilename ?? asset.name) });
  }

  return { eligible, ineligible };
}

/** Structural slice of UploadQueueService — avoids importing the container here. */
interface JobQueue {
  setProgress(jobId: string, progress: number, detail?: string): void;
  isCancelled(jobId: string): boolean;
  heartbeat(jobId: string): void;
  fail(jobId: string, error: string): void;
  complete(jobId: string): void;
}

export interface DeliverAssetsOptions {
  projectId: string;
  token:     string;
  jobId:     string;
  queue:     JobQueue;
  eligible:  EligibleAsset[];
  /** Persist the uploaded rows on the ingest server. Called once after Phase A.
   *  Return `{ ok: false, error }` to abort the job (link left as-is). */
  register:  (r2Assets: R2AssetRecord[]) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Run the full copy pipeline for a set of eligible assets under `token`.
 * Caller is responsible for building `eligible` (validating filePath exists) and
 * for `activeDeliveryJobs.set(token, jobId)` before invoking. Runs to completion
 * or fails the job; always cleans up.
 */
export async function deliverAssets(opts: DeliverAssetsOptions): Promise<void> {
  const { projectId, token, jobId, queue, eligible, register } = opts;

  const mediaDir       = resolveProjectMediaStorageDir(projectId);
  const transcriptsDir = path.join(DATA_DIR, 'projects', projectId, 'transcripts');
  const subtitlesDir   = path.join(DATA_DIR, 'projects', projectId, 'subtitles');
  const total          = eligible.length;
  const videoAssets: { asset: MediaAsset; filename: string; r2Key: string }[] = [];

  try {
    // ── Phase A: Upload originals ───────────────────────────────────────────────
    const r2Assets: R2AssetRecord[] = [];

    queue.setProgress(jobId, 1, `Preparing ${total} file${total !== 1 ? 's' : ''}…`);

    for (let i = 0; i < total; i++) {
      if (queue.isCancelled(jobId)) { cleanup(token); return; }

      const { asset, filename } = eligible[i];
      const filePath = asset.filePath!;
      const fileSize = fs.statSync(filePath).size;
      const ext      = path.extname(filePath).toLowerCase();
      const mimeType = asset.mimeType ?? mimeForExt(ext);
      const r2Key    = `delivery/${token}/${filename}`;

      const bandStart = Math.round((i       / total) * 55) + 1;
      const bandEnd   = Math.round(((i + 1) / total) * 55) + 1;
      const bandSpan  = Math.max(1, bandEnd - bandStart);

      queue.setProgress(jobId, bandStart, `Uploading file ${i + 1} of ${total}: ${filename}…`);

      await uploadToR2({ key: r2Key, filePath, mimeType }, (loaded) => {
        const frac = fileSize > 0 ? Math.min(1, loaded / fileSize) : 0;
        queue.setProgress(
          jobId,
          Math.min(bandEnd, bandStart + Math.round(bandSpan * frac)),
          `Uploading file ${i + 1} of ${total}: ${filename} — ${humanBytes(loaded)} / ${humanBytes(fileSize)}`,
        );
      });

      let thumbnailUrl: string | undefined;
      let thumbnailR2Key: string | undefined;

      if (asset.cloudflare?.uid) {
        thumbnailUrl = `https://videodelivery.net/${asset.cloudflare.uid}/thumbnails/thumbnail.jpg`;
      } else {
        const thumbPath = path.join(mediaDir, `${asset.assetId}.thumb.jpg`);
        if (fs.existsSync(thumbPath)) {
          try {
            const thumbKey = `delivery/${token}/thumbs/${asset.assetId}.jpg`;
            const thumbBuf = fs.readFileSync(thumbPath);
            await s3.send(new PutObjectCommand({
              Bucket: R2_BUCKET, Key: thumbKey, Body: thumbBuf, ContentType: 'image/jpeg',
            }));
            thumbnailR2Key = thumbKey;
          } catch (err) {
            console.warn(`[delivery] thumbnail upload failed for ${asset.assetId}:`, err);
          }
        }
      }

      r2Assets.push({
        r2_key: r2Key, filename, file_size: fileSize, mime_type: mimeType,
        thumbnail_url: thumbnailUrl, thumbnail_r2_key: thumbnailR2Key,
        asset_id: asset.assetId, asset_version: assetVersionOf(asset),
      });

      if (isVideo(mimeType, ext)) {
        videoAssets.push({ asset, filename, r2Key });
      }

      queue.setProgress(
        jobId,
        Math.round(((i + 1) / total) * 55) + 1,
        `Uploaded ${i + 1} of ${total} file${total !== 1 ? 's' : ''}`,
      );
    }

    if (queue.isCancelled(jobId)) { cleanup(token); return; }

    // ── Register: persist rows on the ingest server ─────────────────────────────
    queue.setProgress(jobId, 58, 'Registering delivery link…');

    const reg = await register(r2Assets);
    if (!reg.ok) {
      queue.fail(jobId, reg.error ?? 'Failed to register delivery link');
      cleanup(token);
      return;
    }

    queue.setProgress(jobId, 62, 'Delivery link live — uploading transcripts…');
    console.log(`[delivery] registered ${r2Assets.length} asset(s) for token ${token} (project ${projectId})`);

    // ── Phase B: Upload transcripts ─────────────────────────────────────────────
    for (const { asset, r2Key } of videoAssets) {
      if (queue.isCancelled(jobId)) { cleanup(token); return; }

      const txStatus = asset.transcription?.status;
      const txJobId  = asset.transcription?.jobId;
      if (!txJobId || txStatus !== 'done') continue;

      const candidates: { localPath: string; kind: string; ext: string }[] = [
        { localPath: path.join(transcriptsDir, `${txJobId}.srt`), kind: 'srt', ext: 'srt' },
        { localPath: path.join(subtitlesDir,   `${txJobId}.vtt`), kind: 'vtt', ext: 'vtt' },
        { localPath: path.join(transcriptsDir, `${txJobId}.txt`), kind: 'txt', ext: 'txt' },
      ];

      const toUpload = candidates.filter(c => fs.existsSync(c.localPath));
      if (!toUpload.length) continue;

      const uploadedTranscripts: { r2_key: string; filename: string; file_size: number; kind: string }[] = [];
      const baseName = path.basename(asset.filePath!, path.extname(asset.filePath!));

      for (const { localPath, kind, ext } of toUpload) {
        const txR2Key    = `delivery/${token}/transcripts/${asset.assetId}_${kind}.${ext}`;
        const txFilename = `${sanitize(baseName)}.${ext}`;
        const txSize     = fs.statSync(localPath).size;
        await uploadToR2({ key: txR2Key, filePath: localPath, mimeType: mimeForTranscriptKind(kind) });
        uploadedTranscripts.push({ r2_key: txR2Key, filename: txFilename, file_size: txSize, kind });
      }

      const txRes = await fetch(`${INGEST_URL}/api/delivery/${token}/transcripts`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': INGEST_API_KEY },
        body:    JSON.stringify({ asset_r2_key: r2Key, transcripts: uploadedTranscripts }),
      }).catch(err => { console.warn(`[delivery:${token}] transcript registration fetch failed:`, err); return null });
      if (txRes && !txRes.ok) {
        const t = await txRes.text().catch(() => '');
        console.warn(`[delivery:${token}] transcript registration ${txRes.status}: ${t}`);
      }
    }

    if (queue.isCancelled(jobId)) { cleanup(token); return; }

    // ── Phase C: Transcode + upload proxies ─────────────────────────────────────
    const videoTotal = videoAssets.length;
    if (videoTotal > 0) {
      queue.setProgress(jobId, 68, `Transcoding ${videoTotal} proxy${videoTotal !== 1 ? 's' : ''}…`);
    }

    for (let i = 0; i < videoAssets.length; i++) {
      if (queue.isCancelled(jobId)) { cleanup(token); return; }

      const { asset, filename, r2Key } = videoAssets[i];
      const baseName    = path.basename(filename, path.extname(filename));
      const proxyName   = `${baseName}_proxy.mp4`;
      const proxyR2Key  = `delivery/${token}/${proxyName}`;
      const tmpPath     = path.join(os.tmpdir(), `lpos-proxy-${jobId}-${i}.mp4`);
      const pctStart    = 68 + Math.round((i / videoTotal) * 30);

      queue.setProgress(jobId, pctStart, `Transcoding proxy ${i + 1} of ${videoTotal}: ${filename}…`);

      // ffmpeg runs for minutes with no JS-side callbacks — heartbeat so the
      // upload-queue sweep doesn't auto-fail the job while transcoding.
      const ffmpegHeartbeat = setInterval(() => queue.heartbeat(jobId), 60_000);
      try {
        try {
          await transcodeProxy(asset.filePath!, tmpPath, jobId);
        } finally {
          clearInterval(ffmpegHeartbeat);
        }

        if (queue.isCancelled(jobId)) {
          fs.rmSync(tmpPath, { force: true });
          cleanup(token);
          return;
        }

        const proxySize = fs.statSync(tmpPath).size;
        const proxyBandStart = pctStart + Math.round((30 / videoTotal) * 0.5);
        const proxyBandEnd   = 68 + Math.round(((i + 1) / videoTotal) * 30);
        const proxyBandSpan  = Math.max(1, proxyBandEnd - proxyBandStart);

        queue.setProgress(jobId, proxyBandStart, `Uploading proxy ${i + 1} of ${videoTotal}…`);

        await uploadToR2({ key: proxyR2Key, filePath: tmpPath, mimeType: 'video/mp4' }, (loaded) => {
          const frac = proxySize > 0 ? Math.min(1, loaded / proxySize) : 0;
          queue.setProgress(
            jobId,
            Math.min(proxyBandEnd, proxyBandStart + Math.round(proxyBandSpan * frac)),
            `Uploading proxy ${i + 1} of ${videoTotal}: ${humanBytes(loaded)} / ${humanBytes(proxySize)}`,
          );
        });
        fs.rmSync(tmpPath, { force: true });

        const patchRes = await fetch(`${INGEST_URL}/api/delivery/${token}/assets/proxy`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-api-key': INGEST_API_KEY },
          body:    JSON.stringify({ r2_key: r2Key, proxy_r2_key: proxyR2Key, proxy_file_size: proxySize }),
        }).catch(err => { console.warn(`[delivery:${token}] proxy PATCH fetch failed:`, err); return null });
        if (patchRes && !patchRes.ok) {
          const t = await patchRes.text().catch(() => '');
          console.warn(`[delivery:${token}] proxy PATCH ${patchRes.status}: ${t}`);
        }

        queue.setProgress(
          jobId,
          68 + Math.round(((i + 1) / videoTotal) * 30),
          `Proxy ready: ${filename}`,
        );
      } catch (err) {
        fs.rmSync(tmpPath, { force: true });
        if (queue.isCancelled(jobId)) { cleanup(token); return; }
        console.warn(`[delivery:${token}] proxy transcode failed for ${asset.assetId}:`, err);
      }
    }

    queue.setProgress(jobId, 100, 'All proxies ready');
    setTimeout(() => queue.complete(jobId), 1500);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[delivery] job ${jobId} failed:`, message);
    if (!queue.isCancelled(jobId)) queue.fail(jobId, message);
  } finally {
    cleanup(token);
  }
}

// ── Transcode ────────────────────────────────────────────────────────────────

export function transcodeProxy(inputPath: string, outputPath: string, jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) { reject(new Error('ffmpeg-static binary not found')); return; }

    const proc = spawn(ffmpegPath, [
      '-nostdin',
      '-i', inputPath,
      '-vf', 'scale=min(1920\\,iw):-2',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    activeFfmpegProcs.set(jobId, proc);

    const STDERR_CAP = 4096;
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > STDERR_CAP) stderrBuf = stderrBuf.slice(-STDERR_CAP);
    });

    proc.on('close', (code) => {
      activeFfmpegProcs.delete(jobId);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderrBuf.slice(-300)}`));
    });
    proc.on('error', (err) => {
      activeFfmpegProcs.delete(jobId);
      reject(err);
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function cleanup(token: string) {
  const jobId = activeDeliveryJobs.get(token);
  activeDeliveryJobs.delete(token);
  if (jobId) killFfmpegProc(jobId);
}

export function isVideo(mimeType: string, ext: string): boolean {
  if (VIDEO_MIME_TYPES.has(mimeType)) return true;
  return ['.mp4', '.mov', '.avi', '.mkv', '.mxf', '.webm', '.m4v', '.mts'].includes(ext);
}

export async function uploadToR2(
  { key, filePath, mimeType }: { key: string; filePath: string; mimeType: string },
  onProgress?: (loadedBytes: number) => void,
): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket:      R2_BUCKET,
      Key:         key,
      Body:        fs.createReadStream(filePath),
      ContentType: mimeType,
    },
  });
  if (onProgress) {
    upload.on('httpUploadProgress', (p) => {
      if (typeof p.loaded === 'number') onProgress(p.loaded);
    });
  }
  await upload.done();
}

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function sanitize(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._\-() ]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 200) || 'file';
}

export function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    '.mp4':  'video/mp4',    '.mov':  'video/quicktime',
    '.avi':  'video/x-msvideo', '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',   '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',    '.aac':  'audio/aac',
    '.flac': 'audio/flac',   '.pdf':  'application/pdf',
    '.jpg':  'image/jpeg',   '.jpeg': 'image/jpeg',
    '.png':  'image/png',
  };
  return map[ext] ?? 'application/octet-stream';
}

function mimeForTranscriptKind(kind: string): string {
  if (kind === 'srt') return 'application/x-subrip';
  if (kind === 'vtt') return 'text/vtt';
  return 'text/plain';
}
