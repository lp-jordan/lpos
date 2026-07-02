import fs from 'node:fs';
import path from 'node:path';
import type { MediaAsset } from '@/lib/models/media-asset';
import { withRetry } from '@/lib/utils/retry';

const TUS_VERSION = '1.0.0';
const DEFAULT_CHUNK_BYTES = Number(process.env.CLOUDFLARE_STREAM_CHUNK_BYTES ?? 32 * 1024 * 1024);
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_READY_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_UPLOAD_RETRIES = 5;

interface CloudflareConfig {
  accountId: string;
  auth:
    | { kind: 'bearer'; apiToken: string }
    | { kind: 'global-key'; apiKey: string; authEmail: string };
  customerSubdomain: string | null;
}

export interface CloudflarePreparedVideo {
  uid: string;
  uploadUrl: string;
}

export interface CloudflareVideoState {
  uid: string;
  status: 'uploading' | 'processing' | 'ready';
  previewUrl: string | null;
  thumbnailUrl: string | null;
  hlsUrl: string | null;
  dashUrl: string | null;
  uploadedAt: string | null;
  readyAt: string | null;
}

type ConfigDiagnostic = {
  ok: boolean;
  accountId: string | null;
  apiToken: string | null;
  apiKey: string | null;
  authEmail: string | null;
  customerSubdomain: string | null;
  authMode: 'bearer' | 'global-key' | 'missing';
  message: string | null;
  details: string[];
};

function readCloudflareEnv() {
  return {
    accountId: process.env.CLOUDFLARE_STREAM_ACCOUNT_ID?.trim()
      || process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
      || null,
    apiToken: process.env.CLOUDFLARE_STREAM_API_TOKEN?.trim()
      || process.env.CLOUDFLARE_STREAM_TOKEN?.trim()
      || null,
    apiKey: process.env.CLOUDFLARE_GLOBAL_API_KEY?.trim()
      || process.env.CLOUDFLARE_API_KEY?.trim()
      || null,
    authEmail: process.env.CLOUDFLARE_AUTH_EMAIL?.trim()
      || process.env.CLOUDFLARE_EMAIL?.trim()
      || null,
    customerSubdomain: process.env.CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN?.trim() || null,
  };
}

/**
 * Default playback origins stamped onto every managed Cloudflare upload (auto
 * upload + manual push). The LPOS host so the in-app player can fetch HLS, plus
 * the LeaderPass platform domain. Override via CLOUDFLARE_STREAM_ALLOWED_ORIGINS
 * (comma-separated). Per-video add/remove happens afterward via the Security
 * modal, which writes allowedOrigins directly on the CF uid.
 *
 * NOTE: this is the interim security model — allowedOrigins only, no
 * requireSignedURLs (see the project_cloudflare_auto_upload plan).
 */
const DEFAULT_ALLOWED_ORIGINS = ['lpos.tail856ed3.ts.net', 'app.leaderpass.com'];

/** Reduce a URL or host string to a bare hostname[:port] for Cloudflare allowedOrigins. */
function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

export function getDefaultAllowedOrigins(): string[] {
  const env = process.env.CLOUDFLARE_STREAM_ALLOWED_ORIGINS?.trim();
  const list = env ? env.split(',') : DEFAULT_ALLOWED_ORIGINS;
  return list.map(normalizeOrigin).filter(Boolean);
}

export function getCloudflareStreamConfigDiagnostic(): ConfigDiagnostic {
  const env = readCloudflareEnv();
  const details: string[] = [];
  const hasBearerAuth = Boolean(env.apiToken);
  const hasGlobalKeyAuth = Boolean(env.apiKey && env.authEmail);

  if (!env.accountId) {
    details.push('Missing account ID. Set CLOUDFLARE_STREAM_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID.');
  }

  if (!hasBearerAuth && !hasGlobalKeyAuth) {
    details.push(
      'Missing Cloudflare auth. Set CLOUDFLARE_STREAM_API_TOKEN (preferred) or CLOUDFLARE_API_KEY plus CLOUDFLARE_AUTH_EMAIL.',
    );
  }

  if (env.accountId && !/^[a-f0-9]{32,36}$/i.test(env.accountId)) {
    details.push('Cloudflare account ID does not look valid. Expected a 32–36 character hex string.');
  }

  return {
    ok: details.length === 0,
    accountId: env.accountId,
    apiToken: env.apiToken,
    apiKey: env.apiKey,
    authEmail: env.authEmail,
    customerSubdomain: env.customerSubdomain,
    authMode: hasBearerAuth ? 'bearer' : hasGlobalKeyAuth ? 'global-key' : 'missing',
    message: details.length === 0 ? null : details.join(' '),
    details,
  };
}

function getConfig(): CloudflareConfig {
  const diagnostic = getCloudflareStreamConfigDiagnostic();
  if (!diagnostic.ok || !diagnostic.accountId) {
    throw new Error(diagnostic.message ?? 'Cloudflare Stream is not configured correctly.');
  }

  return {
    accountId: diagnostic.accountId,
    auth: diagnostic.authMode === 'bearer' && diagnostic.apiToken
      ? { kind: 'bearer', apiToken: diagnostic.apiToken }
      : {
          kind: 'global-key',
          apiKey: diagnostic.apiKey!,
          authEmail: diagnostic.authEmail!,
        },
    customerSubdomain: diagnostic.customerSubdomain,
  };
}

function authHeaders(config: CloudflareConfig): HeadersInit {
  if (config.auth.kind === 'bearer') {
    return {
      Authorization: `Bearer ${config.auth.apiToken}`,
    };
  }

  return {
    'X-Auth-Key': config.auth.apiKey,
    'X-Auth-Email': config.auth.authEmail,
  };
}

function describeAuthForLogs(config: CloudflareConfig): Record<string, string | string[] | boolean | null> {
  const headers = authHeaders(config) as Record<string, string>;

  if (config.auth.kind === 'bearer') {
    return {
      authMode: 'bearer',
      hasAuthorizationHeader: Boolean(headers.Authorization),
      headerNames: Object.keys(headers),
      tokenPrefix: config.auth.apiToken ? `${config.auth.apiToken.slice(0, 5)}...` : null,
    };
  }

  return {
    authMode: 'global-key',
    hasAuthKeyHeader: Boolean(headers['X-Auth-Key']),
    hasAuthEmailHeader: Boolean(headers['X-Auth-Email']),
    headerNames: Object.keys(headers),
    authEmail: config.auth.authEmail || null,
    apiKeyPrefix: config.auth.apiKey ? `${config.auth.apiKey.slice(0, 4)}...` : null,
  };
}

function encodeMetadata(metadata: Record<string, string | null | undefined>): string {
  return Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key} ${Buffer.from(String(value), 'utf8').toString('base64')}`)
    .join(',');
}

async function parseCloudflareResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as { success?: boolean; errors?: Array<{ message?: string; code?: number }>; result?: T };
  if (!response.ok || payload.success === false || !payload.result) {
    const message = payload.errors?.map((error) => {
      if (error.code === 9106) {
        return 'Cloudflare rejected the request because no supported auth header was accepted. Restart LPOS to reload .env.local, or set CLOUDFLARE_API_KEY plus CLOUDFLARE_AUTH_EMAIL as a fallback auth mode.';
      }
      if (error.code) return `${error.message ?? 'Cloudflare error'} (code ${error.code})`;
      return error.message;
    }).filter(Boolean).join('; ') || `Cloudflare API ${response.status}`;
    throw new Error(message);
  }
  return payload.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTusUploadOffset(uploadUrl: string, config: CloudflareConfig): Promise<number | null> {
  const response = await fetch(uploadUrl, {
    method: 'HEAD',
    headers: {
      ...authHeaders(config),
      'Tus-Resumable': TUS_VERSION,
    },
  });

  if (!response.ok) {
    return null;
  }

  const offset = Number(response.headers.get('Upload-Offset'));
  return Number.isFinite(offset) ? offset : null;
}

async function uploadTusChunk(
  uploadUrl: string,
  config: CloudflareConfig,
  body: Buffer,
  offset: number,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(uploadUrl, {
    method: 'PATCH',
    headers: {
      ...authHeaders(config),
      'Tus-Resumable': TUS_VERSION,
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream',
      'Content-Length': String(body.byteLength),
    },
    body,
    signal,
  });
}

export function isCloudflareStreamConfigured(): boolean {
  return getCloudflareStreamConfigDiagnostic().ok;
}

export async function createCloudflareTusUpload(asset: MediaAsset): Promise<CloudflarePreparedVideo> {
  if (!asset.filePath) {
    throw new Error('Asset has no file path.');
  }

  const config = getConfig();
  const stat = fs.statSync(asset.filePath);
  const metadata = encodeMetadata({
    name: asset.name || asset.originalFilename,
  });
  const headers = {
    ...authHeaders(config),
    'Tus-Resumable': TUS_VERSION,
    'Upload-Length': String(stat.size),
    'Upload-Creator': asset.assetId.slice(0, 64),
    ...(metadata ? { 'Upload-Metadata': metadata } : {}),
  };

  console.log('[cloudflare] upload init request', {
    accountId: config.accountId,
    filePath: asset.filePath,
    fileSize: stat.size,
    ...describeAuthForLogs(config),
    requestHeaderNames: Object.keys(headers),
  });

  const response = await withRetry(
    () => fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream`, {
      method: 'POST',
      headers,
    }),
    4,
    (err) => {
      if (err instanceof TypeError) return true;
      const msg = err instanceof Error ? err.message : String(err);
      return /\b(429|500|502|503|504)\b/.test(msg);
    },
  );

  if (response.status !== 201) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      bodyText = '';
    }
    if (bodyText.includes('"code":9106')) {
      throw new Error(
        'Cloudflare rejected the upload-init request because no supported auth header was accepted. Restart LPOS to reload .env.local, or configure CLOUDFLARE_API_KEY plus CLOUDFLARE_AUTH_EMAIL as a fallback.',
      );
    }
    throw new Error(bodyText || `Cloudflare upload init failed (${response.status}). Check the account ID, API token permissions, and token IP restriction.`);
  }

  const uploadUrl = response.headers.get('location');
  const uid = response.headers.get('stream-media-id');
  if (!uploadUrl || !uid) {
    throw new Error('Cloudflare upload init succeeded but did not return an upload URL and stream media ID.');
  }

  return { uid, uploadUrl };
}

export async function uploadFileToCloudflareTus(
  uploadUrl: string,
  filePath: string,
  options?: {
    chunkSize?: number;
    onProgress?: (percent: number) => void;
    isCancelled?: () => boolean;
  },
): Promise<void> {
  const config = getConfig();
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_BYTES;
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(chunkSize);
  let offset = 0;

  // Cancel responsiveness: chunks default to 32 MB, so the gate at the top of
  // the loop is too coarse to tear down a chunk that's actively flying over a
  // slow uplink. Poll isCancelled() every 250ms; when it flips, abort the
  // in-flight fetch at the socket so the error path runs immediately instead
  // of waiting for the current chunk to finish.
  const controller = new AbortController();
  const cancelPoll = options?.isCancelled
    ? setInterval(() => {
        if (options.isCancelled!() && !controller.signal.aborted) {
          controller.abort();
        }
      }, 250)
    : null;

  const ensureNotCancelled = () => {
    if (options?.isCancelled?.()) throw new Error('Cancelled');
  };

  try {
    while (offset < stat.size) {
      ensureNotCancelled();

      const bytesToRead = Math.min(chunkSize, stat.size - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      const body = buffer.subarray(0, bytesRead);
      let response: Response | null = null;
      let lastErrorText = '';

      for (let attempt = 0; attempt <= DEFAULT_UPLOAD_RETRIES; attempt += 1) {
        ensureNotCancelled();
        let networkErr: unknown = null;
        try {
          response = await uploadTusChunk(uploadUrl, config, body, offset, controller.signal);
        } catch (err) {
          // AbortController-driven cancellation surfaces as an AbortError —
          // map it to our 'Cancelled' contract so the catch site can clean up
          // the Cloudflare-side video and asset record.
          if (controller.signal.aborted || options?.isCancelled?.()) {
            throw new Error('Cancelled');
          }
          // Any other throw is a transport-level failure (undici 'fetch failed':
          // ECONNRESET, socket hang up, connect timeout, DNS, TLS). TUS is
          // resumable, so fall through to the SAME back-off/offset-resync path
          // as a 5xx response instead of failing the whole upload. Previously
          // this re-threw and skipped the retry loop entirely, so a single
          // transient reset killed the upload with a bare "fetch failed".
          networkErr = err;
          response = null;
        }

        if (response && response.ok) {
          break;
        }

        // A thrown network error and a retryable HTTP status are both transient.
        const retryable = networkErr !== null || response!.status >= 500 || response!.status === 409;
        if (!retryable || attempt === DEFAULT_UPLOAD_RETRIES) {
          if (networkErr !== null) {
            const cause = (networkErr as { cause?: unknown }).cause;
            const detail = cause instanceof Error ? cause.message : cause ? String(cause) : '';
            throw new Error(
              `Cloudflare upload chunk network error after ${attempt + 1} attempt(s)${detail ? ` (${detail})` : ''}`,
              { cause: networkErr },
            );
          }
          lastErrorText = await response!.text();
          throw new Error(lastErrorText || `Cloudflare upload chunk failed (${response!.status}).`);
        }

        // Resume from wherever Cloudflare actually stopped receiving. Best-effort:
        // if the offset probe itself fails (e.g. still mid-outage), fall through
        // to the back-off and retry the same chunk.
        const remoteOffset = await getTusUploadOffset(uploadUrl, config).catch(() => null);
        if (remoteOffset !== null && remoteOffset > offset) {
          offset = remoteOffset;
          break;
        }

        await sleep(Math.min(1_000 * 2 ** attempt, 16_000));
      }

      if (!response?.ok) {
        continue;
      }

      const nextOffset = Number(response.headers.get('Upload-Offset') ?? offset + bytesRead);
      offset = Number.isFinite(nextOffset) ? nextOffset : offset + bytesRead;
      options?.onProgress?.(Math.min(100, Math.round((offset / stat.size) * 100)));
    }
  } finally {
    if (cancelPoll) clearInterval(cancelPoll);
    fs.closeSync(fd);
  }
}

type CloudflareVideoResult = {
  uid?: string;
  preview?: string;
  thumbnail?: string;
  created?: string;
  readyToStream?: boolean;
  status?: { state?: string };
  playback?: {
    hls?: string;
    dash?: string;
  };
};

function derivePlaybackUrls(uid: string, customerSubdomain: string | null): Pick<CloudflareVideoState, 'previewUrl' | 'thumbnailUrl' | 'hlsUrl' | 'dashUrl'> {
  const previewUrl = `https://watch.cloudflarestream.com/${uid}`;
  if (!customerSubdomain) {
    return {
      previewUrl,
      thumbnailUrl: null,
      hlsUrl: null,
      dashUrl: null,
    };
  }

  const base = `https://customer-${customerSubdomain}.cloudflarestream.com/${uid}`;
  return {
    previewUrl,
    thumbnailUrl: `${base}/thumbnails/thumbnail.jpg`,
    hlsUrl: `${base}/manifest/video.m3u8`,
    dashUrl: `${base}/manifest/video.mpd`,
  };
}

export async function getCloudflareVideoState(uid: string): Promise<CloudflareVideoState> {
  const config = getConfig();
  const response = await withRetry(() =>
    fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${uid}`, {
      headers: authHeaders(config),
    }),
  );
  const result = await parseCloudflareResponse<CloudflareVideoResult>(response);
  const fallbackUrls = derivePlaybackUrls(uid, config.customerSubdomain);
  const ready = Boolean(result.readyToStream);

  return {
    uid,
    status: ready ? 'ready' : 'processing',
    previewUrl: result.preview ?? fallbackUrls.previewUrl,
    thumbnailUrl: result.thumbnail ?? fallbackUrls.thumbnailUrl,
    hlsUrl: result.playback?.hls ?? fallbackUrls.hlsUrl,
    dashUrl: result.playback?.dash ?? fallbackUrls.dashUrl,
    uploadedAt: result.created ?? null,
    readyAt: ready ? new Date().toISOString() : null,
  };
}

export async function waitForCloudflareVideoReady(
  uid: string,
  options?: {
    timeoutMs?: number;
    pollMs?: number;
    isCancelled?: () => boolean;
  },
): Promise<CloudflareVideoState> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (options?.isCancelled?.()) {
      throw new Error('Cancelled');
    }

    const state = await getCloudflareVideoState(uid);
    if (state.status === 'ready') {
      return state;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error('Cloudflare Stream processing timed out before the asset became ready.');
}

export function getCloudflareFileSize(filePath: string): number {
  return fs.statSync(path.resolve(filePath)).size;
}

interface VideoSettings {
  allowedOrigins?: string[];
  thumbnailTimestampPct?: number;
  requireSignedURLs?: boolean;
}

/**
 * Updates metadata on an existing Cloudflare Stream video.
 * Only sends fields that are explicitly provided.
 */
export async function applyVideoSettings(uid: string, settings: VideoSettings): Promise<void> {
  const config = getConfig();
  const body: Record<string, unknown> = {};
  if (settings.allowedOrigins !== undefined) body.allowedOrigins = settings.allowedOrigins;
  if (settings.thumbnailTimestampPct !== undefined) body.thumbnailTimestampPct = settings.thumbnailTimestampPct;
  if (settings.requireSignedURLs !== undefined) body.requireSignedURLs = settings.requireSignedURLs;

  const response = await withRetry(() =>
    fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${uid}`, {
      method: 'POST',
      headers: {
        ...authHeaders(config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );

  await parseCloudflareResponse(response);
}

/**
 * Reads the current per-video metadata Cloudflare Stream is holding for `uid`.
 * We only expose the fields the UI needs — extend the return type as more get
 * surfaced. Throws on non-success response.
 */
export async function getVideoDetails(uid: string): Promise<{ allowedOrigins: string[]; requireSignedURLs: boolean }> {
  const config = getConfig();
  const response = await withRetry(() =>
    fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${uid}`, {
      method: 'GET',
      headers: authHeaders(config),
    }),
  );

  const result = await parseCloudflareResponse<{ allowedOrigins?: string[] | null; requireSignedURLs?: boolean }>(response);
  return {
    allowedOrigins: Array.isArray(result.allowedOrigins) ? result.allowedOrigins : [],
    requireSignedURLs: result.requireSignedURLs === true,
  };
}

/**
 * Uploads a WebVTT file as captions for an existing Cloudflare Stream video.
 * Uses PUT /accounts/{id}/stream/{uid}/captions/{language} with multipart/form-data.
 * Errors are thrown so callers can decide whether to swallow them.
 */
export async function uploadCaptionsVtt(uid: string, vttPath: string, language = 'en'): Promise<void> {
  const config = getConfig();
  const vttBuffer = fs.readFileSync(vttPath);
  const form = new FormData();
  form.append('file', new Blob([vttBuffer], { type: 'text/vtt' }), path.basename(vttPath));

  const response = await withRetry(() =>
    fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${uid}/captions/${language}`,
      {
        method: 'PUT',
        headers: authHeaders(config),
        body: form,
      },
    ),
  );

  await parseCloudflareResponse(response);
}

/**
 * Permanently deletes a video from Cloudflare Stream by UID.
 * Errors are thrown so callers can decide whether to swallow them.
 */
export async function deleteCloudflareVideo(uid: string): Promise<void> {
  const config = getConfig();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${uid}`,
    {
      method: 'DELETE',
      headers: authHeaders(config),
    },
  );

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch { /* ignore */ }
    throw new Error(body || `Cloudflare Stream delete failed (${response.status})`);
  }
}

export interface CloudflareVideoSummary {
  uid: string;
  status: string;
  created: string | null;
  meta: Record<string, unknown> | null;
  /** Cloudflare's "creator" field — we set this to the LPOS assetId (truncated to 64 chars) on upload */
  creator: string | null;
}

/**
 * Lists all videos in the account. Pages until the result count is < page size.
 * Used by the orphan reconciler — do NOT call on a hot path.
 */
export async function listCloudflareVideos(): Promise<CloudflareVideoSummary[]> {
  const config = getConfig();
  const collected: CloudflareVideoSummary[] = [];
  const pageSize = 1000;
  let before: string | null = null;

  // Cloudflare's Stream list endpoint paginates via `before` (a timestamp) — see docs.
  // We stop when a page returns fewer items than the page size.
  // Hard cap of 50 pages so a misbehaving API doesn't spin forever.
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream`);
    url.searchParams.set('limit', String(pageSize));
    if (before) url.searchParams.set('before', before);

    const response = await fetch(url.toString(), { method: 'GET', headers: authHeaders(config) });
    const result = await parseCloudflareResponse<Array<{ uid: string; status?: { state?: string }; created?: string; meta?: Record<string, unknown>; creator?: string }>>(response);

    for (const v of result) {
      collected.push({
        uid: v.uid,
        status: v.status?.state ?? 'unknown',
        created: v.created ?? null,
        meta: v.meta ?? null,
        creator: v.creator ?? null,
      });
    }

    if (result.length < pageSize) return collected;
    const oldest = result[result.length - 1].created;
    if (!oldest || oldest === before) return collected;
    before = oldest;
  }

  return collected;
}
