import fs from 'node:fs';
import path from 'node:path';
import type { MediaAsset } from '@/lib/models/media-asset';

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

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream`, {
    method: 'POST',
    headers,
  });

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

  try {
    while (offset < stat.size) {
      if (options?.isCancelled?.()) {
        throw new Error('Cancelled');
      }

      const bytesToRead = Math.min(chunkSize, stat.size - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      const body = buffer.subarray(0, bytesRead);
      let response: Response | null = null;
      let lastErrorText = '';

      for (let attempt = 0; attempt <= DEFAULT_UPLOAD_RETRIES; attempt += 1) {
        response = await uploadTusChunk(uploadUrl, config, body, offset);

        if (response.ok) {
          break;
        }

        lastErrorText = await response.text();
        const retryable = response.status >= 500 || response.status === 409;
        if (!retryable || attempt === DEFAULT_UPLOAD_RETRIES) {
          throw new Error(lastErrorText || `Cloudflare upload chunk failed (${response.status}).`);
        }

        const remoteOffset = await getTusUploadOffset(uploadUrl, config);
        if (remoteOffset !== null && remoteOffset > offset) {
          offset = remoteOffset;
          break;
        }

        await sleep(1_000 * (attempt + 1));
      }

      if (!response?.ok) {
        continue;
      }

      const nextOffset = Number(response.headers.get('Upload-Offset') ?? offset + bytesRead);
      offset = Number.isFinite(nextOffset) ? nextOffset : offset + bytesRead;
      options?.onProgress?.(Math.min(100, Math.round((offset / stat.size) * 100)));
    }
  } finally {
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
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${uid}`, {
    headers: authHeaders(config),
  });
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
