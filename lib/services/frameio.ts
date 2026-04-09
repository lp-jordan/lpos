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
 *   FRAMEIO_ACCOUNT_ID     — Frame.io account UUID (optional but recommended;
 *                            skips all auto-discovery probes if set)
 */

import fs from 'node:fs';
import { Readable } from 'node:stream';
import { getValidAccessToken } from './frameio-tokens';
import { withRetry } from '@/lib/utils/retry';

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
  const method = init?.method ?? 'GET';
  return withRetry(
    async () => {
      const res = await fetch(url, {
        ...init,
        headers: {
          ...(await authHeaders()),
          ...((init?.headers as Record<string, string>) ?? {}),
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Frame.io V4 ${method} ${url} → ${res.status}: ${body}`);
      }

      return res;
    },
    4,
    (err) => {
      if (err instanceof TypeError) return true; // network error
      const msg = err instanceof Error ? err.message : String(err);
      if (/→ 429\b/.test(msg)) return true;
      // Only retry 5xx on safe (read-only) methods to avoid duplicate creates
      if (/→ (500|502|503|504)\b/.test(msg)) return method === 'GET' || method === 'HEAD';
      return false;
    },
  );
}

// ── Discovery (cached per process) ───────────────────────────────────────────

interface DiscoveryResult {
  accountId:    string;
  workspaceId:  string;   // for webhooks
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
  // 0 ── Explicit env var — skips all probing (recommended for production)
  const envId = process.env.FRAMEIO_ACCOUNT_ID?.trim();
  if (envId) return envId;

  const token    = await getValidAccessToken();
  const claims   = decodeJwtPayload(token);
  const clientId = process.env.FRAMEIO_CLIENT_ID?.trim() ?? '';

  // 1 ── Look for account_id directly in JWT claims
  const claimId =
    claims['frameio_account_id'] ??
    claims['account_id'] ??
    claims['https://frameio.com/account_id'];
  if (typeof claimId === 'string' && claimId) {
    console.log('[frameio] account_id resolved from JWT claim:', claimId);
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
    console.log('[frameio] v2/me probe status:', res.status);
    if (res.ok) {
      const me = await res.json() as Record<string, unknown>;
      console.log('[frameio] v2/me keys:', Object.keys(me).join(', '));
      if (typeof me.account_id === 'string' && me.account_id) return me.account_id;
    } else {
      const text = await res.text().catch(() => '');
      console.log('[frameio] v2/me error body:', text.slice(0, 200));
    }
  } catch (e) {
    console.log('[frameio] v2/me probe threw:', e);
  }

  // 3 ── Try v4 /me
  try {
    const res = await fetch(`${BASE_V4}/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-api-key':   clientId,
        Accept:        'application/json',
      },
    });
    console.log('[frameio] v4/me probe status:', res.status);
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      const data = (body.data ?? body) as Record<string, unknown>;
      console.log('[frameio] v4/me keys:', Object.keys(data).join(', '));
      const id = data.account_id ?? data.frameio_account_id;
      if (typeof id === 'string' && id) return id;
    } else {
      const text = await res.text().catch(() => '');
      console.log('[frameio] v4/me error body:', text.slice(0, 200));
    }
  } catch (e) {
    console.log('[frameio] v4/me probe threw:', e);
  }

  // 4 ── Try v4 /accounts (no account_id needed in path)
  try {
    const res = await fetch(`${BASE_V4}/accounts`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-api-key':   clientId,
        Accept:        'application/json',
      },
    });
    console.log('[frameio] v4/accounts probe status:', res.status);
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      console.log('[frameio] v4/accounts body keys:', Object.keys(body).join(', '));
      const items = (Array.isArray(body) ? body : (body.data ?? [])) as { id?: string }[];
      console.log('[frameio] v4/accounts item count:', items.length, '| first id:', items[0]?.id);
      if (items.length > 0 && items[0].id) return items[0].id;
    } else {
      const text = await res.text().catch(() => '');
      console.log('[frameio] v4/accounts error body:', text.slice(0, 200));
    }
  } catch (e) {
    console.log('[frameio] v4/accounts probe threw:', e);
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

  // Step 2: List workspaces
  const wsRes    = await fioFetch(`${BASE_V4}/accounts/${accountId}/workspaces`);
  const wsBody   = await wsRes.json() as { data?: V4Workspace[] } | V4Workspace[];
  const workspaces: V4Workspace[] = Array.isArray(wsBody)
    ? wsBody
    : (wsBody.data ?? []);

  if (workspaces.length === 0) {
    throw new Error(`No workspaces found in Frame.io account ${accountId}`);
  }

  // Step 3: Search each workspace's projects for the matching name
  let match: V4Project | null = null;
  let workspaceWithProject = '';
  const allProjects: V4Project[] = [];

  for (const ws of workspaces) {
    const projRes  = await fioFetch(`${BASE_V4}/accounts/${accountId}/workspaces/${ws.id}/projects`);
    const projBody = await projRes.json() as { data?: V4Project[] } | V4Project[];
    const projects: V4Project[] = Array.isArray(projBody)
      ? projBody
      : (projBody.data ?? []);

    allProjects.push(...projects);

    const found = projects.find((p) => p.name === projectName);
    if (found) { match = found; workspaceWithProject = ws.id; break; }
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

  _cached = { accountId, workspaceId: workspaceWithProject, projectId: match.id, rootFolderId };
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

  // ── Step 2: Upload binary to S3 (stream each part — avoids INT32_MAX fs.readSync limit) ──
  // fs.readSync's `length` parameter is capped at INT32_MAX (2 147 483 647), so any file
  // or Frame.io chunk larger than 2 GiB would throw ERR_OUT_OF_RANGE if read into a buffer.
  // Using fs.createReadStream with { start, end } streams each part directly without buffering.
  //
  // Parts are uploaded in parallel batches (CHUNK_CONCURRENCY at a time) to make full use
  // of available upload bandwidth instead of serialising each PUT.
  const CHUNK_CONCURRENCY = 4;

  // Precompute byte offsets for each part so concurrent uploads can seek independently
  let offsetAccum = 0;
  const parts = uploadUrls.map(({ url, size }) => {
    const start = offsetAccum;
    offsetAccum += size;
    return { url, size, start };
  });

  for (let i = 0; i < parts.length; i += CHUNK_CONCURRENCY) {
    if (cancelCheck?.()) throw new Error('Cancelled');

    const batch = parts.slice(i, i + CHUNK_CONCURRENCY);
    console.log(
      `[frameio-v4] uploading parts ${i + 1}–${Math.min(i + CHUNK_CONCURRENCY, parts.length)}` +
      `/${parts.length}…`,
    );

    await Promise.all(batch.map(async ({ url, size, start }, batchIdx) => {
      const partNum = i + batchIdx + 1;
      const readStream = fs.createReadStream(filePath, { start, end: start + size - 1 });
      const webStream = Readable.toWeb(readStream) as ReadableStream<Uint8Array>;

      const putRes = await fetch(url, {
        method:  'PUT',
        // @ts-expect-error — Node.js built-in fetch requires duplex for streaming request bodies
        duplex:  'half',
        body:    webStream,
        headers: {
          'Content-Type':   mimeType,
          'Content-Length': String(size),
          'x-amz-acl':      'private',
        },
      });

      if (!putRes.ok) {
        throw new Error(`S3 PUT part ${partNum}/${parts.length} failed: ${putRes.status}`);
      }
    }));
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

// ── Version stacks ────────────────────────────────────────────────────────────

export interface FrameIOVersionStackResult {
  stackId: string;
  viewUrl: string | null;
}

/**
 * Create a Frame.io version stack from two existing files.
 * The first file is the older version; the second is the newer version.
 *
 * POST /v4/accounts/{id}/folders/{folderId}/version_stacks
 * Body: { data: { file_ids: [oldFileId, newFileId] } }
 */
export async function createVersionStack(
  folderId: string,
  oldFileId: string,
  newFileId: string,
): Promise<FrameIOVersionStackResult> {
  const { accountId } = await discover();
  const res = await fioFetch(
    `${BASE_V4}/accounts/${accountId}/folders/${folderId}/version_stacks`,
    {
      method: 'POST',
      body: JSON.stringify({ data: { file_ids: [oldFileId, newFileId] } }),
    },
  );
  const body = await res.json() as {
    data?: { id: string; view_url?: string | null };
    errors?: { message?: string }[];
  };
  if (!res.ok || !body.data?.id) {
    const msg = body.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new Error(`Frame.io version stack creation failed: ${msg}`);
  }
  console.log(`[frameio-v4] version stack created: ${body.data.id}`);
  return { stackId: body.data.id, viewUrl: body.data.view_url ?? null };
}

/**
 * Add a file to an existing Frame.io version stack by moving it.
 *
 * PATCH /v4/accounts/{id}/files/{fileId}/move
 * Body: { data: { parent_id: stackId } }
 */
export async function addFileToVersionStack(
  fileId: string,
  stackId: string,
): Promise<void> {
  const { accountId } = await discover();
  const res = await fioFetch(
    `${BASE_V4}/accounts/${accountId}/files/${fileId}/move`,
    {
      method: 'PATCH',
      body: JSON.stringify({ data: { parent_id: stackId } }),
    },
  );
  if (!res.ok) {
    const body = await res.json() as { errors?: { message?: string }[] };
    const msg = body.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new Error(`Frame.io move to version stack failed: ${msg}`);
  }
  console.log(`[frameio-v4] file ${fileId} moved into version stack ${stackId}`);
}

// ── Share links ───────────────────────────────────────────────────────────────

// ── Share link types ──────────────────────────────────────────────────────────

export interface FrameIOShare {
  id:                  string;
  name:                string;
  shareUrl:            string;
  createdAt:           string;    // ISO string
  fileCount:           number | null;  // from local store; null = not tracked by LPOS
  downloading_enabled: boolean | null;
  commenting_enabled:    boolean | null;
  access:              'public' | 'private' | null;
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
export async function createShareLink(
  fileIds:   string[],
  shareName: string,
  settings?: Pick<ShareSettings, 'downloading_enabled'>,
): Promise<FrameIOShare> {
  const { accountId, projectId } = await discover();

  // Work from a mutable copy so we can drop stale IDs on retry.
  const activeIds = [...fileIds];

  // Frame.io rejects the entire share creation if any asset_id is not found,
  // and names the offending ID in the error detail. Retry after stripping it.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (activeIds.length === 0) {
      throw new Error('Frame.io createShareLink: all provided asset IDs were rejected as not found on Frame.io.');
    }

    let shareRes: Response;
    try {
      shareRes = await fioFetch(
        `${BASE_V4}/accounts/${accountId}/projects/${projectId}/shares`,
        {
          method: 'POST',
          body: JSON.stringify({
            data: {
              type:                'asset',
              access:              'public',
              name:                shareName,
              asset_ids:           activeIds,
              downloading_enabled: settings?.downloading_enabled ?? true,
            },
          }),
        },
      );
    } catch (err) {
      // "Assets: <uuid> not found." — strip the bad ID and retry.
      const uuidMatch = /Assets:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+not found/i
        .exec((err as Error).message);
      if (uuidMatch) {
        const badId = uuidMatch[1];
        const idx = activeIds.indexOf(badId);
        if (idx !== -1) {
          console.warn(`[frameio] createShareLink: skipping asset ${badId} — not found on Frame.io`);
          activeIds.splice(idx, 1);
          continue;
        }
      }
      throw err;
    }

    const shareBody = await shareRes.json() as {
      data?: {
        id: string; name?: string; short_url?: string; url?: string; link?: string;
        inserted_at?: string; downloading_enabled?: boolean; commenting_enabled?: boolean;
        access?: 'public' | 'private';
      };
    };
    const share = shareBody.data;

    if (!share?.id) {
      throw new Error(
        `Frame.io createShareLink: no share id returned. Got: ${JSON.stringify(shareBody)}`,
      );
    }

    const shareUrl = share.short_url ?? share.url ?? share.link ?? `https://app.frame.io/r/${share.id}`;

    return {
      id:                  share.id,
      name:                share.name ?? shareName,
      shareUrl,
      createdAt:           share.inserted_at ?? new Date().toISOString(),
      fileCount:           activeIds.length,
      downloading_enabled: share.downloading_enabled ?? true,
      commenting_enabled:    share.commenting_enabled ?? null,
      access:              share.access ?? 'public',
    };
  }
}

/**
 * List all share presentations for the discovered Frame.io project.
 * GET /v4/accounts/{id}/projects/{projectId}/shares
 */
export async function listShares(): Promise<FrameIOShare[]> {
  const { accountId, projectId } = await discover();
  const res  = await fioFetch(`${BASE_V4}/accounts/${accountId}/projects/${projectId}/shares`);
  const body = await res.json() as {
    data?: {
      id: string; name?: string; short_url?: string; url?: string; link?: string;
      inserted_at?: string; downloading_enabled?: boolean; commenting_enabled?: boolean;
      access?: 'public' | 'private';
    }[];
  };

  return (body.data ?? []).map((s) => ({
    id:                  s.id,
    name:                s.name ?? `Share ${s.id.slice(0, 6)}`,
    shareUrl:            s.short_url ?? s.url ?? s.link ?? `https://app.frame.io/r/${s.id}`,
    createdAt:           s.inserted_at ?? '',
    fileCount:           null,  // enriched by route handlers that have local store access
    downloading_enabled: s.downloading_enabled ?? null,
    commenting_enabled:    s.commenting_enabled ?? null,
    access:              s.access ?? null,
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

export interface ShareSettings {
  name?:               string;
  downloading_enabled?: boolean;
}

/**
 * Update one or more settings on an existing share.
 * PATCH /v4/accounts/{id}/shares/{shareId}
 */
export async function updateShareSettings(shareId: string, settings: ShareSettings): Promise<void> {
  const { accountId } = await discover();
  console.log('[frameio] PATCH share', shareId, 'with', JSON.stringify(settings));
  const res = await fioFetch(`${BASE_V4}/accounts/${accountId}/shares/${shareId}`, {
    method: 'PATCH',
    body:   JSON.stringify({ data: settings }),
  });
  const body = await res.json().catch(() => null);
  console.log('[frameio] PATCH share response:', JSON.stringify(body));
}

/**
 * Rename an existing share.
 * @deprecated Use updateShareSettings({ name }) instead.
 */
export async function renameShare(shareId: string, name: string): Promise<void> {
  await updateShareSettings(shareId, { name });
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
  duration:    number | null;   // seconds; non-null = spanning/range comment
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
      id:          string;
      text:        string;
      timestamp?:  number | null;
      duration?:   number | null;
      completed?:  boolean;
      inserted_at?: string | null;
      created_at?:  string | null;
      author?:     { name?: string; avatar_url?: string | null };
      owner?:      { name?: string; avatar_url?: string | null };
      replies?:   {
        id:           string;
        text:         string;
        inserted_at?: string | null;
        created_at?:  string | null;
        author?:      { name?: string; avatar_url?: string | null };
        owner?:       { name?: string; avatar_url?: string | null };
      }[];
    }[];
  };

  return (body.data ?? []).map((c) => {
    const author = c.author ?? c.owner;
    return {
      id:           c.id,
      text:         c.text,
      // Frame.io stores timestamps in 1/60-second units; convert to seconds for display
      timestamp:    c.timestamp != null ? c.timestamp / 60 : null,
      duration:     c.duration  != null ? c.duration  / 60 : null,
      authorName:   author?.name ?? '',
      authorAvatar: author?.avatar_url ?? null,
      createdAt:    c.inserted_at ?? c.created_at ?? '',
      completed:    c.completed ?? false,
      replies:      (c.replies ?? []).map((r) => {
        const ra = r.author ?? r.owner;
        return {
          id:           r.id,
          text:         r.text,
          authorName:   ra?.name ?? '',
          authorAvatar: ra?.avatar_url ?? null,
          createdAt:    r.inserted_at ?? r.created_at ?? '',
        };
      }),
    };
  });
}

/**
 * Post a new comment on a Frame.io file.
 * POST /v4/accounts/{id}/files/{file_id}/comments
 * timestamp: seconds into the video (optional)
 * duration:  length of the range in seconds (optional, requires timestamp)
 */
export async function postComment(
  fileId:    string,
  text:      string,
  timestamp: number | null = null,
  duration:  number | null = null,
): Promise<FrameIOComment> {
  const { accountId } = await discover();

  const body: Record<string, unknown> = { text };
  if (timestamp !== null) {
    // Convert seconds → Frame.io 1/60-second units
    body.timestamp = Math.round(timestamp * 60);
    if (duration !== null && duration > 0) body.duration = Math.round(duration * 60);
  }

  const res    = await fioFetch(
    `${BASE_V4}/accounts/${accountId}/files/${fileId}/comments`,
    { method: 'POST', body: JSON.stringify({ data: body }) },
  );
  const result = await res.json() as {
    data?: {
      id:           string;
      text:         string;
      timestamp?:   number | null;
      duration?:    number | null;
      completed?:   boolean;
      inserted_at?: string | null;
      created_at?:  string | null;
      author?:      { name?: string; avatar_url?: string | null };
      owner?:       { name?: string; avatar_url?: string | null };
    };
  };

  const c      = result.data;
  if (!c) throw new Error('Frame.io postComment returned no data');
  const author = c.author ?? c.owner;

  return {
    id:           c.id,
    text:         c.text,
    timestamp:    c.timestamp != null ? c.timestamp / 60 : null,
    duration:     c.duration  != null ? c.duration  / 60 : null,
    authorName:   author?.name ?? '',
    authorAvatar: author?.avatar_url ?? null,
    createdAt:    c.inserted_at ?? c.created_at ?? '',
    completed:    c.completed ?? false,
    replies:      [],
  };
}

/**
 * Post a reply to an existing comment.
 * POST /v4/accounts/{id}/files/{file_id}/comments  (with parent_id)
 */
export async function postReply(
  fileId:   string,
  parentId: string,
  text:     string,
): Promise<FrameIOCommentReply> {
  const { accountId } = await discover();
  const res    = await fioFetch(
    `${BASE_V4}/accounts/${accountId}/files/${fileId}/comments`,
    { method: 'POST', body: JSON.stringify({ data: { text, parent_id: parentId } }) },
  );
  const result = await res.json() as {
    data?: {
      id:           string;
      text:         string;
      inserted_at?: string | null;
      created_at?:  string | null;
      author?:      { name?: string; avatar_url?: string | null };
      owner?:       { name?: string; avatar_url?: string | null };
    };
  };
  const c = result.data;
  if (!c) throw new Error('Frame.io postReply returned no data');
  const author = c.author ?? c.owner;
  return {
    id:           c.id,
    text:         c.text,
    authorName:   author?.name ?? '',
    authorAvatar: author?.avatar_url ?? null,
    createdAt:    c.inserted_at ?? c.created_at ?? '',
  };
}

/**
 * Delete a comment on a Frame.io file.
 * DELETE /v4/accounts/{id}/comments/{comment_id}
 */
export async function deleteComment(commentId: string): Promise<void> {
  const { accountId } = await discover();
  await fioFetch(
    `${BASE_V4}/accounts/${accountId}/comments/${commentId}`,
    { method: 'DELETE' },
  );
}

/**
 * Update the text of an existing comment.
 * PATCH /v4/accounts/{id}/comments/{comment_id}
 */
export async function updateComment(commentId: string, text: string): Promise<void> {
  const { accountId } = await discover();
  await fioFetch(
    `${BASE_V4}/accounts/${accountId}/comments/${commentId}`,
    { method: 'PATCH', body: JSON.stringify({ data: { text } }) },
  );
}

/**
 * Toggle the completed/resolved state of a comment.
 * PATCH /v4/accounts/{id}/comments/{comment_id}
 */
export async function toggleCommentCompleted(commentId: string, completed: boolean): Promise<void> {
  const { accountId } = await discover();
  await fioFetch(
    `${BASE_V4}/accounts/${accountId}/comments/${commentId}`,
    { method: 'PATCH', body: JSON.stringify({ data: { completed } }) },
  );
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

export interface FrameIOWebhook {
  id:      string;
  name:    string;
  url:     string;
  active:  boolean;
  events:  string[];
  secret?: string;   // only returned on create
}

/**
 * Register a new webhook in the workspace that contains the configured project.
 * POST /v4/accounts/{id}/workspaces/{ws}/webhooks
 */
export async function registerWebhook(
  name:   string,
  url:    string,
  events: string[],
): Promise<FrameIOWebhook> {
  const { accountId, workspaceId } = await discover();
  const res  = await fioFetch(
    `${BASE_V4}/accounts/${accountId}/workspaces/${workspaceId}/webhooks`,
    {
      method: 'POST',
      body:   JSON.stringify({ data: { name, url, events } }),
    },
  );
  const body = await res.json() as {
    data?: { id: string; name: string; url: string; active: boolean; events: string[]; secret?: string };
  };
  const d = body.data;
  if (!d?.id) throw new Error(`Frame.io registerWebhook returned no id. Got: ${JSON.stringify(body)}`);
  return { id: d.id, name: d.name, url: d.url, active: d.active, events: d.events, secret: d.secret };
}

/**
 * List webhooks registered in the workspace that contains the configured project.
 * GET /v4/accounts/{id}/workspaces/{ws}/webhooks
 */
export async function listWebhooks(): Promise<FrameIOWebhook[]> {
  const { accountId, workspaceId } = await discover();
  const res  = await fioFetch(`${BASE_V4}/accounts/${accountId}/workspaces/${workspaceId}/webhooks`);
  const body = await res.json() as {
    data?: { id: string; name: string; url: string; active: boolean; events: string[] }[];
  };
  return (body.data ?? []).map((d) => ({
    id: d.id, name: d.name, url: d.url, active: d.active, events: d.events,
  }));
}

/**
 * Delete a webhook by ID.
 * DELETE /v4/accounts/{id}/webhooks/{webhook_id}
 */
export async function deleteWebhook(webhookId: string): Promise<void> {
  const { accountId } = await discover();
  await fioFetch(`${BASE_V4}/accounts/${accountId}/webhooks/${webhookId}`, { method: 'DELETE' });
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
