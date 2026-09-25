/**
 * R2 helpers for share downloads: upload, delete, presigned GET, and the 1080p
 * web-copy encode. Clients download straight from R2 (free egress) through a
 * short-lived presigned URL — never through LPOS.
 *
 * Credentials: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 * (the bucket the old delivery links used). Objects live under
 * SHARE_DOWNLOADS_R2_PREFIX (default `share-downloads`; dev uses its own prefix).
 *
 * Upload/encode code is carried over from the retired delivery pipeline
 * (lib/services/delivery-upload.ts before e1afcec).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import ffmpegPath from 'ffmpeg-static';

const ENDPOINT   = (process.env.R2_ENDPOINT ?? '').replace(/\/$/, '');
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID ?? '';
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY ?? '';
const BUCKET     = process.env.R2_BUCKET ?? '';

export const SHARE_DOWNLOADS_PREFIX = (process.env.SHARE_DOWNLOADS_R2_PREFIX ?? 'share-downloads').replace(/^\/+|\/+$/g, '');

export function isShareR2Configured(): boolean {
  return !!(ENDPOINT && ACCESS_KEY && SECRET_KEY && BUCKET);
}

let client: S3Client | null = null;
function s3(): S3Client {
  client ??= new S3Client({
    region: 'auto',
    endpoint: ENDPOINT,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  return client;
}

export async function uploadFileToR2(
  key: string, filePath: string, contentType: string, onProgress?: (loaded: number) => void,
): Promise<void> {
  const upload = new Upload({
    client: s3(),
    params: { Bucket: BUCKET, Key: key, Body: fs.createReadStream(filePath), ContentType: contentType },
  });
  if (onProgress) upload.on('httpUploadProgress', (p) => { if (typeof p.loaded === 'number') onProgress(p.loaded); });
  await upload.done();
}

export async function deleteR2Object(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// ── Presigned GET (AWS SigV4, query-string auth) ──────────────────────────────
// Hand-rolled so no presigner dependency is needed. R2 accepts region "auto".

/** RFC 3986 encoding (encodeURIComponent leaves !'()* alone; SigV4 must not). */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = (data: string) => crypto.createHash('sha256').update(data).digest('hex');

/** A URL that downloads `key` for `expiresIn` seconds, saved as `filename`. */
export function presignR2Get(key: string, filename: string, expiresIn = 4 * 3600): string {
  const url = new URL(ENDPOINT);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');   // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;

  const canonicalUri = `/${[BUCKET, ...key.split('/')].map(rfc3986).join('/')}`;
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${ACCESS_KEY}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
    'response-content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${rfc3986(filename)}`,
  };
  const canonicalQuery = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`).join('&');
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let signingKey = hmac(`AWS4${SECRET_KEY}`, dateStamp);
  for (const part of ['auto', 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ── Web copy encode ───────────────────────────────────────────────────────────

/** H.264 ≤1080p, CRF 23, faststart — the old delivery pipeline's proxy settings. */
export function encodeWebCopy(inputPath: string, outputPath: string, onProc?: (p: ChildProcess) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) { reject(new Error('ffmpeg-static binary not found')); return; }
    const proc = spawn(ffmpegPath, [
      '-nostdin', '-i', inputPath,
      '-vf', 'scale=min(1920\\,iw):-2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    onProc?.(proc);
    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-4096); });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`))));
    proc.on('error', reject);
  });
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'video';
}

export function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.mxf': 'application/mxf',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
    '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.txt': 'text/plain',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}
