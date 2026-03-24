/**
 * Frame.io V4 API service
 *
 * Uses the Adobe IMS OAuth access token (stored in data/frameio-tokens.json).
 * Connect once via https://localhost:3000/api/auth/frameio/connect — tokens
 * are refreshed automatically and silently thereafter.
 *
 * V4 API base: https://api.frame.io/v4/accounts/{account_id}/...
 *
 * Discovery flow:
 *   /v4/accounts/{id}/workspaces                    → workspace_id(s)
 *   /v4/accounts/{id}/workspaces/{ws}/projects      → find by FRAMEIO_PROJECT_NAME
 *   project.root_folder_id                          → root folder for uploads
 *
 * Upload flow:
 *   1. getOrCreateProjectFolder(name)
 *      → find/create subfolder in project root
 *   2. uploadAsset(folderId, ...)
 *      → POST .../files/local_upload → upload_urls (S3)
 *      → PUT chunks to S3
 *      → POST .../projects/{id}/shares → share (review link)
 *      → POST .../shares/{id}/assets   → attach file
 *
 * Env vars (set in .env.local):
 *   FRAMEIO_CLIENT_ID      — Adobe Developer Console client ID
 *   FRAMEIO_CLIENT_SECRET  — Adobe Developer Console client secret
 *   FRAMEIO_PROJECT_NAME   — Exact name of your Frame.io project
 */

import fs from 'node:fs';
import { getValidAccessToken } from './frameio-tokens';

const BASE_V4 = 'https://api.frame.io/v4';

// ── Auth / fetch helpers ──────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
  const token    = await getValidAccessToken();
  const clientId = process.env.FRAMEIO_CLIENT_ID?.trim();
  if (!clientId) throw new Error('FRAMEIO_CLIENT_ID is not set in .env.local');
  return {
    Authorization:  `Bearer ${token}`,
    'x-api-key':    clientId,
    'Content-Type': 'application/json',
    Accept:         'application/json',
  };
}

async function fioFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(await authHeaders()),
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Frame.io V4 ${init?.method ?? 'GET'} ${url} → ${res.status}: ${body}`);
  }

  return res;
}

// ── Discovery (cached per process) ───────────────────────────────────────────

interface DiscoveryResult {
  accountId:    string;
  projectId:    string;   // for shares
  rootFolderId: string;   // for uploads
}

let _cached: DiscoveryResult | null = null;

interface V4Workspace {
  id:   string;
  name: string;
}

interface V4Project {
  id:             string;
  name:           string;
  root_folder_id: string;   // V4 field
  // Some V4 responses may use different keys — logged for diagnostics
  [key: string]: unknown;
}

/**
 * Decode a JWT payload without verifying the signature.
 * Adobe IMS access tokens are JWTs — the account_id is often
 * embedded as a claim (e.g. "frameio_account_id", "account_id",
 * or inside an "as" / "user_id" field).
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts   = token.split('.');
    if (parts.length < 2) return {};
    // URL-safe base64 → standard base64
    const padded  = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function resolveAccountId(): Promise<string> {
  const token   = await getValidAccessToken();
  const claims  = decodeJwtPayload(token);
  const clientId = process.env.FRAMEIO_CLIENT_ID?.trim() ?? '';

  console.log('[frameio-v4] JWT claims keys:', Object.keys(claims).join(', '));

  // 1 ── Look for account_id directly in JWT claims
  const claimId =
    claims['frameio_account_id'] ??
    claims['account_id'] ??
    claims['https://frameio.com/account_id'];
  if (typeof claimId === 'string' && claimId) {
    console.log('[frameio-v4] account_id from JWT claim:', claimId);
    return claimId;
  }

  // 2 ── Try v2 /me (may work with OAuth token on legacy-enabled accounts)
  try {
    const res = await fetch('https://api.frame.io/v2/me', {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-api-key':   clientId,
        'x-frameio-legacy-token-auth': 'true',
      },
    });
    if (res.ok) {
      const me = await res.json() as Record<string, unknown>;
      console.log('[frameio-v4] v2/me keys:', Object.keys(me).join(', '));
      if (typeof me.account_id === 'string' && me.account_id) return me.account_id;
    } else {
      console.log('[frameio-v4] v2/me status:', res.status);
    }
  } catch (e) {
    console.log('[frameio-v4] v2/me error:', e);
  }

  // 3 ── Try v4 /me
  try {
    const res  = await fetch(`${BASE_V4}/me`, {
      headers: {
        Authorization:  `Bearer ${token}`,
        'x-api-key':    clientId,
        Accept:         'application/json',
      },
    });
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      console.log('[frameio-v4] v4/me keys:', Object.keys(body).join(', '));
      const data = (body.data ?? body) as Record<string, unknown>;
      console.log('[frameio-v4] v4/me data keys:', Object.keys(data).join(', '));
      const id = data.account_id ?? data.frameio_account_id;
      if (typeof id === 'string' && id) return id;
    } else {
      const txt = await res.text().catch(() => '');
      console.log('[frameio-v4] v4/me status:', res.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.log('[frameio-v4] v4/me error:', e);
  }

  // 4 ── Try v4 /accounts (no account_id needed in path)
  try {
    const res  = await fetch(`${BASE_V4}/accounts`, {
      headers: {
        Authorization:  `Bearer ${token}`,
        'x-api-key':    clientId,
        Accept:         'application/json',
      },
    });
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      console.log('[frameio-v4] /v4/accounts keys:', Object.keys(body).join(', '));
      const items = (Array.isArray(body) ? body : (body.data ?? [])) as { id?: string }[];
      if (items.length > 0 && items[0].id) return items[0].id;
    } else {
      const txt = await res.text().catch(() => '');
      console.log('[frameio-v4] /v4/accounts status:', res.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.log('[frameio-v4] /v4/accounts error:', e);
  }

  // Nothing worked — throw with useful diagnostic
  throw new Error(
    'Could not determine Frame.io account_id.\n' +
    `JWT claims present: ${Object.keys(claims).join(', ')}\n` +
    'Check server logs for detailed probe results.',
  );
}

async function discover(): Promise<DiscoveryResult> {
  if (_cached) return _cached;

  const projectName = process.env.FRAMEIO_PROJECT_NAME?.trim();
  if (!projectName) throw new Error('FRAMEIO_PROJECT_NAME is not set in .env.local');

  // Step 1: Resolve account_id via multiple strategies
  const accountId = await resolveAccountId();
  console.log(`[frameio-v4] account_id: ${accountId}`);

  // Step 2: List workspaces
  const wsRes    = await fioFetch(`${BASE_V4}/accounts/${accountId}/workspaces`);
  const wsBody   = await wsRes.json() as { data?: V4Workspace[] } | V4Workspace[];
  const workspaces: V4Workspace[] = Array.isArray(wsBody)
    ? wsBody
    : (wsBody.data ?? []);

  if (workspaces.length === 0) {
    throw new Error(`No workspaces found in Frame.io account ${accountId}`);
  }

  console.log(`[frameio-v4] workspaces: ${workspaces.map((w) => `"${w.name}"`).join(', ')}`);

  // Step 3: Search each workspace's projects for the matching name
  let match: V4Project | null = null;
  const allProjects: V4Project[] = [];

  for (const ws of workspaces) {
    const projRes  = await fioFetch(`${BASE_V4}/accounts/${accountId}/workspaces/${ws.id}/projects`);
    const projBody = await projRes.json() as { data?: V4Project[] } | V4Project[];
    const projects: V4Project[] = Array.isArray(projBody)
      ? projBody
      : (projBody.data ?? []);

    allProjects.push(...projects);

    const found = projects.find((p) => p.name === projectName);
    if (found) { match = found; break; }
  }

  if (!match) {
    const available = allProjects.map((p) => `"${p.name}"`).join(', ');
    throw new Error(
      `Frame.io project "${projectName}" not found.\n` +
      `Available in your workspaces: ${available || '(none)'}`,
    );
  }

  // V4 project root folder — field name may vary, log the object keys to help debug
  const rootFolderId = (match.root_folder_id as string | undefined) ?? '';
  if (!rootFolderId) {
    console.warn('[frameio-v4] project object keys:', Object.keys(match).join(', '));
    throw new Error(
      `Frame.io project "${projectName}" found but has no root_folder_id. ` +
      `Keys: ${Object.keys(match).join(', ')}`,
    );
  }

  console.log(`[frameio-v4] project "${match.name}" → root_folder_id: ${rootFolderId}`);

  _cached = { accountId, projectId: match.id, rootFolderId };
  return _cached;
}

// ── Folder helpers ────────────────────────────────────────────────────────────

interface V4FolderChild {
  id:   string;
  name: string;
  type: string;
}

/** V4: GET /v4/accounts/{id}/folders/{folder_id}/children */
async function listChildren(accountId: string, folderId: string): Promise<V4FolderChild[]> {
  const res  = await fioFetch(`${BASE_V4}/accounts/${accountId}/folders/${folderId}/children`);
  const body = await res.json() as { data?: V4FolderChild[] };
  return body.data ?? [];
}

/**
 * Create a subfolder inside parentId.
 * V4: POST /v4/accounts/{id}/folders/{parent_id}/folders
 */
async function createFolder(accountId: string, parentId: string, name: string): Promise<string> {
  const res  = await fioFetch(`${BASE_V4}/accounts/${accountId}/folders/${parentId}/folders`, {
    method: 'POST',
    body:   JSON.stringify({ data: { name } }),
  });
  const body = await res.json() as { data?: { id: string }; id?: string };
  const id   = body.data?.id ?? (body as { id?: string }).id;
  if (!id) throw new Error(`Frame.io V4 createFolder did not return an id. Got: ${JSON.stringify(body)}`);
  return id;
}

/**
 * Find or create a subfolder inside the project root matching lposProjectName.
 * Falls back to project root if anything goes wrong.
 */
export async function getOrCreateProjectFolder(lposProjectName: string): Promise<string> {
  const { accountId, rootFolderId } = await discover();

  try {
    const children = await listChildren(accountId, rootFolderId);
    const existing = children.find((c) => c.type === 'folder' && c.name === lposProjectName);
    if (existing) return existing.id;
    const id = await createFolder(accountId, rootFolderId, lposProjectName);
    console.log(`[frameio-v4] created subfolder "${lposProjectName}" → ${id}`);
    return id;
  } catch (err) {
    console.warn(`[frameio-v4] subfolder setup failed, using project root: ${(err as Error).message}`);
    return rootFolderId;
  }
}

// ── Upload ────────────────────────────────────────────────────────────────────

export interface FrameIOUploadResult {
  frameioAssetId: string;
  playerUrl:      string | null;
  reviewLink:     string | null;
}

/**
 * Upload a local file to a Frame.io V4 folder.
 *
 * 1. POST /v4/accounts/{id}/folders/{folderId}/files/local_upload
 *    → { data: { id, upload_urls } }
 * 2. PUT each chunk to the pre-signed S3 URLs
 * 3. POST /v4/accounts/{id}/projects/{projectId}/shares   → share container
 *    POST /v4/accounts/{id}/shares/{shareId}/assets       → attach file
 */
export async function uploadAsset(
  folderId: string,
  name:     string,
  filePath: string,
  mimeType: string,
  fileSize: number,
  cancelCheck?: () => boolean,
): Promise<FrameIOUploadResult> {

  const { accountId, projectId } = await discover();

  // ── Step 1: Create file placeholder ───────────────────────────────────────
  // V4: POST /v4/accounts/{id}/folders/{folder_id}/files/local_upload
  // Body: { data: { name, file_size } }
  // Response upload_urls is an array of { url, size } objects, not plain strings.
  const createRes = await fioFetch(
    `${BASE_V4}/accounts/${accountId}/folders/${folderId}/files/local_upload`,
    {
      method: 'POST',
      body:   JSON.stringify({
        data: { name, file_size: fileSize },
      }),
    },
  );

  const createBody = await createRes.json() as {
    data?: {
      id:          string;
      upload_urls: { url: string; size: number }[];
      player_url?: string | null;
    };
    errors?: { message?: string }[];
    message?: string;
  };

  // Frame.io rejects files > 2 GiB with a size error — surface it cleanly
  if (!createRes.ok) {
    const raw = createBody.errors?.[0]?.message ?? createBody.message ?? `HTTP ${createRes.status}`;
    if (raw.toLowerCase().includes('greater than 2') || raw.toLowerCase().includes('file size')) {
      const mb = Math.round(fileSize / (1024 * 1024));
      throw new Error(`File is ${mb} MB — exceeds Frame.io's 2 GB per-file limit`);
    }
    throw new Error(`Frame.io rejected upload: ${raw}`);
  }

  const fileRecord = createBody.data;
  if (!fileRecord?.id)          throw new Error('Frame.io V4 local_upload did not return a file id');
  if (!fileRecord.upload_urls?.length) throw new Error('Frame.io V4 local_upload returned no upload_urls');

  const fileId     = fileRecord.id;
  const uploadUrls = fileRecord.upload_urls;   // [{ url, size }]

  console.log(`[frameio-v4] file ${fileId} created, ${uploadUrls.length} upload part(s)`);

  // ── Step 2: Upload binary to S3 (read one chunk at a time — no full-file buffer) ──
  const fd     = fs.openSync(filePath, 'r');
  let   offset = 0;

  try {
    for (let i = 0; i < uploadUrls.length; i++) {
      const { url, size } = uploadUrls[i];
      const chunk = Buffer.allocUnsafe(size);
      const bytesRead = fs.readSync(fd, chunk, 0, size, offset);
      const slice = bytesRead < size ? chunk.subarray(0, bytesRead) : chunk;
      offset += bytesRead;

      console.log(`[frameio-v4] uploading part ${i + 1}/${uploadUrls.length} (${slice.length} bytes)…`);

      const putRes = await fetch(url, {
        method:  'PUT',
        body:    slice,
        headers: {
          'Content-Type':   mimeType,
          'Content-Length': String(slice.length),
          'x-amz-acl':      'private',
        },
      });

      if (!putRes.ok) {
        throw new Error(`S3 PUT part ${i + 1}/${uploadUrls.length} failed: ${putRes.status}`);
      }

      // Check for cancellation after each part so we stop promptly
      if (cancelCheck?.()) throw new Error('Cancelled');
    }
  } finally {
    fs.closeSync(fd);
  }

  console.log(`[frameio-v4] upload complete for "${name}"`);

  // ── Step 3: Fetch file details for view URL ────────────────────────────────
  // local_upload doesn't return a player/view URL — fetch the file record to get it.
  let playerUrl: string | null = null;
  try {
    const fileRes  = await fioFetch(`${BASE_V4}/accounts/${accountId}/files/${fileId}`);
    const fileBody = await fileRes.json() as {
      data?: { view_url?: string; player_url?: string; link?: string };
    };
    const f = fileBody.data;
    playerUrl = f?.player_url ?? f?.view_url ?? f?.link ?? null;
    if (playerUrl) console.log(`[frameio-v4] player/view url: ${playerUrl}`);
    else           console.log(`[frameio-v4] file keys: ${Object.keys(f ?? {}).join(', ')}`);
  } catch (err) {
    console.warn('[frameio-v4] could not fetch file details (non-fatal):', err);
  }

  // Per-upload auto-review links have been removed — users create share links
  // explicitly via the Shares panel in the project Media tab.
  // Store the player URL as the review link fallback for the detail panel.
  const reviewLink: string | null = playerUrl;

  return { frameioAssetId: fileId, playerUrl, reviewLink };
}

// ── Share links ───────────────────────────────────────────────────────────────

// ── Share link types ──────────────────────────────────────────────────────────

export interface FrameIOShare {
  id:        string;
  name:      string;
  shareUrl:  string;
  createdAt: string;   // ISO string
}

export interface FrameIOShareFile {
  id:   string;   // Frame.io file ID
  name: string;
}

// ── Share link helpers ────────────────────────────────────────────────────────

/**
 * Create a Frame.io share presentation for one or more files.
 * Returns the share URL (short_url preferred, falls back to constructed URL).
 *
 * POST /v4/accounts/{id}/projects/{projectId}/shares
 * POST /v4/accounts/{id}/shares/{shareId}/files  (attach file IDs)
 */
export async function createShareLink(fileIds: string[], shareName: string): Promise<FrameIOShare> {
  const { accountId, projectId } = await discover();

  // Create the share — V4 spec requires type="asset" and access field.
  // asset_ids can be included directly in the creation body.
  const shareRes = await fioFetch(
    `${BASE_V4}/accounts/${accountId}/projects/${projectId}/shares`,
    {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type:                 'asset',
          access:               'public',
          name:                 shareName,
          asset_ids:            fileIds,
          downloading_enabled:  true,
        },
      }),
    },
  );

  const shareBody = await shareRes.json() as {
    data?: { id: string; name?: string; short_url?: string; url?: string; link?: string; inserted_at?: string };
  };
  const share = shareBody.data;

  if (!share?.id) {
    throw new Error(
      `Frame.io createShareLink: no share id returned. Got: ${JSON.stringify(shareBody)}`,
    );
  }

  const shareUrl = share.short_url ?? share.url ?? share.link ?? `https://app.frame.io/r/${share.id}`;
  console.log(`[frameio-v4] created share "${shareName}" with ${fileIds.length} file(s): ${shareUrl}`);

  return {
    id:        share.id,
    name:      share.name ?? shareName,
    shareUrl,
    createdAt: share.inserted_at ?? new Date().toISOString(),
  };
}

/**
 * List all share presentations for the discovered Frame.io project.
 * GET /v4/accounts/{id}/projects/{projectId}/shares
 */
export async function listShares(): Promise<FrameIOShare[]> {
  const { accountId, projectId } = await discover();
  const res  = await fioFetch(`${BASE_V4}/accounts/${accountId}/projects/${projectId}/shares`);
  const body = await res.json() as {
    data?: { id: string; name?: string; short_url?: string; url?: string; link?: string; inserted_at?: string }[];
  };

  return (body.data ?? []).map((s) => ({
    id:        s.id,
    name:      s.name ?? `Share ${s.id.slice(0, 6)}`,
    shareUrl:  s.short_url ?? s.url ?? s.link ?? `https://app.frame.io/r/${s.id}`,
    createdAt: s.inserted_at ?? '',
  }));
}

// NOTE: The Frame.io V4 API provides no endpoint to list assets in a share.
// Asset membership is tracked locally via lib/store/share-assets-store.ts.

/**
 * Add assets to an existing share — one request per asset (API is singular).
 * POST /v4/accounts/{id}/shares/{shareId}/assets
 * Body: { data: { asset_id: "uuid" } }
 */
export async function addFilesToShare(shareId: string, fileIds: string[]): Promise<void> {
  const { accountId } = await discover();
  for (const fileId of fileIds) {
    await fioFetch(`${BASE_V4}/accounts/${accountId}/shares/${shareId}/assets`, {
      method: 'POST',
      body:   JSON.stringify({ data: { asset_id: fileId } }),
    });
  }
}

/**
 * Permanently delete a file/asset from Frame.io.
 * DELETE /v4/accounts/{id}/files/{fileId}
 */
export async function deleteFrameioFile(fileId: string): Promise<void> {
  const { accountId } = await discover();
  await fioFetch(`${BASE_V4}/accounts/${accountId}/files/${fileId}`, { method: 'DELETE' });
}

/**
 * Remove a single asset from a share.
 * DELETE /v4/accounts/{id}/shares/{shareId}/assets/{assetId}
 */
export async function removeFileFromShare(shareId: string, fileId: string): Promise<void> {
  const { accountId } = await discover();
  await fioFetch(
    `${BASE_V4}/accounts/${accountId}/shares/${shareId}/assets/${fileId}`,
    { method: 'DELETE' },
  );
}

/**
 * Rename an existing share.
 * PATCH /v4/accounts/{id}/shares/{shareId}
 */
export async function renameShare(shareId: string, name: string): Promise<void> {
  const { accountId } = await discover();
  await fioFetch(`${BASE_V4}/accounts/${accountId}/shares/${shareId}`, {
    method: 'PATCH',
    body:   JSON.stringify({ data: { name } }),
  });
}

/**
 * Permanently delete a share (the link becomes invalid).
 * DELETE /v4/accounts/{id}/shares/{shareId}
 */
export async function deleteShare(shareId: string): Promise<void> {
  const { accountId } = await discover();
  await fioFetch(`${BASE_V4}/accounts/${accountId}/shares/${shareId}`, { method: 'DELETE' });
}

// ── Comments ──────────────────────────────────────────────────────────────────

export interface FrameIOComment {
  id:          string;
  text:        string;
  timestamp:   number | null;   // seconds into the video, null = general comment
  authorName:  string;
  authorAvatar: string | null;
  createdAt:   string;
  completed:   boolean;
  replies:     FrameIOCommentReply[];
}

export interface FrameIOCommentReply {
  id:          string;
  text:        string;
  authorName:  string;
  authorAvatar: string | null;
  createdAt:   string;
}

/**
 * Fetch all comments on a Frame.io file.
 * GET /v4/accounts/{id}/files/{file_id}/comments
 */
export async function getComments(fileId: string): Promise<FrameIOComment[]> {
  const { accountId } = await discover();
  const res  = await fioFetch(`${BASE_V4}/accounts/${accountId}/files/${fileId}/comments`);
  const body = await res.json() as {
    data?: {
      id:         string;
      text:       string;
      timestamp?: number | null;
      completed?: boolean;
      inserted_at: string;
      author?:    { name?: string; avatar_url?: string | null };
      owner?:     { name?: string; avatar_url?: string | null };
      replies?:   {
        id:          string;
        text:        string;
        inserted_at: string;
        author?:     { name?: string; avatar_url?: string | null };
        owner?:      { name?: string; avatar_url?: string | null };
      }[];
    }[];
  };

  return (body.data ?? []).map((c) => {
    const author = c.author ?? c.owner;
    return {
      id:           c.id,
      text:         c.text,
      timestamp:    c.timestamp ?? null,
      authorName:   author?.name ?? 'Unknown',
      authorAvatar: author?.avatar_url ?? null,
      createdAt:    c.inserted_at,
      completed:    c.completed ?? false,
      replies:      (c.replies ?? []).map((r) => {
        const ra = r.author ?? r.owner;
        return {
          id:           r.id,
          text:         r.text,
          authorName:   ra?.name ?? 'Unknown',
          authorAvatar: ra?.avatar_url ?? null,
          createdAt:    r.inserted_at,
        };
      }),
    };
  });
}

/**
 * Post a new comment on a Frame.io file.
 * POST /v4/accounts/{id}/files/{file_id}/comments
 * timestamp: seconds into the video (optional)
 */
export async function postComment(
  fileId:    string,
  text:      string,
  timestamp: number | null = null,
): Promise<FrameIOComment> {
  const { accountId } = await discover();

  const body: Record<string, unknown> = { text };
  if (timestamp !== null) body.timestamp = timestamp;

  const res    = await fioFetch(
    `${BASE_V4}/accounts/${accountId}/files/${fileId}/comments`,
    { method: 'POST', body: JSON.stringify({ data: body }) },
  );
  const result = await res.json() as {
    data?: {
      id:          string;
      text:        string;
      timestamp?:  number | null;
      completed?:  boolean;
      inserted_at: string;
      author?:     { name?: string; avatar_url?: string | null };
      owner?:      { name?: string; avatar_url?: string | null };
    };
  };

  const c      = result.data;
  if (!c) throw new Error('Frame.io postComment returned no data');
  const author = c.author ?? c.owner;

  return {
    id:           c.id,
    text:         c.text,
    timestamp:    c.timestamp ?? null,
    authorName:   author?.name ?? 'Unknown',
    authorAvatar: author?.avatar_url ?? null,
    createdAt:    c.inserted_at,
    completed:    c.completed ?? false,
    replies:      [],
  };
}

// ── Media stream URLs ─────────────────────────────────────────────────────────

export interface FrameIOMediaLinks {
  /** Streamable high-quality transcode (no Content-Disposition). Best for <video> playback. */
  highQualityUrl:  string | null;
  /** Streamable efficient transcode — smaller file, still good quality. */
  efficientUrl:    string | null;
  /** Original file inline URL — plays in browser without forcing download. */
  originalUrl:     string | null;
  /** Thumbnail image URL. */
  thumbnailUrl:    string | null;
}

/**
 * Fetches the media_links for a Frame.io file — CDN URLs for streaming/playback.
 * These URLs are presigned and expire, so fetch fresh on each request.
 */
export async function getFileMediaLinks(fileId: string): Promise<FrameIOMediaLinks> {
  const { accountId } = await discover();
  const include = [
    'media_links.high_quality',
    'media_links.efficient',
    'media_links.original',
    'media_links.thumbnail_high_quality',
  ].join(',');
  const res  = await fioFetch(
    `${BASE_V4}/accounts/${accountId}/files/${fileId}?include=${encodeURIComponent(include)}`,
  );
  const body = await res.json() as {
    data?: {
      media_links?: {
        high_quality?:           { url?: string | null; download_url?: string | null };
        efficient?:              { url?: string | null };
        original?:               { inline_url?: string | null };
        thumbnail?:              { url?: string | null };
        thumbnail_high_quality?: { url?: string | null };
      };
    };
  };

  const ml = body.data?.media_links ?? {};
  return {
    highQualityUrl: ml.high_quality?.url          ?? null,
    efficientUrl:   ml.efficient?.url             ?? null,
    originalUrl:    ml.original?.inline_url        ?? null,
    thumbnailUrl:   ml.thumbnail_high_quality?.url ?? ml.thumbnail?.url ?? null,
  };
}
