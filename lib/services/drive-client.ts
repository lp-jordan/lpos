/**
 * Google Drive API client
 *
 * Authenticates via service account (server-to-server — no user OAuth needed).
 * The service account must be added as a Contributor to the Shared Team Drive.
 *
 * All methods pass supportsAllDrives + includeItemsFromAllDrives so they work
 * correctly against Shared Drives (not just My Drive).
 *
 * Env vars (set in .env.local):
 *   GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH  — path to service account JSON key file
 *                                        (e.g. ./data/drive-service-account.json)
 *   GOOGLE_DRIVE_SHARED_DRIVE_ID       — the Shared Team Drive ID (from Drive URL)
 *   GOOGLE_DRIVE_WEBHOOK_TOKEN         — token sent with push notifications for verification
 *   GOOGLE_DRIVE_WEBHOOK_URL           — public HTTPS URL for Drive to POST notifications to
 */

import path from 'node:path';
import fs   from 'node:fs';
import { google, drive_v3 } from 'googleapis';
import { Readable } from 'node:stream';
import { withRetry } from '@/lib/utils/retry';

// Wraps a googleapis call with exponential back-off (429 / 5xx / network errors).
function driveCall<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(fn);
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _drive: drive_v3.Drive | null = null;

export function getDriveClient(): drive_v3.Drive {
  if (_drive) return _drive;

  const keyPath = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH;
  if (!keyPath) throw new Error('[drive-client] GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH is not set');

  const resolved = path.isAbsolute(keyPath)
    ? keyPath
    : path.join(process.cwd(), keyPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`[drive-client] Service account key file not found: ${resolved}`);
  }

  const key = JSON.parse(fs.readFileSync(resolved, 'utf8'));

  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

// ── Shared constants ──────────────────────────────────────────────────────────

const SHARED_DRIVE_PARAMS = {
  supportsAllDrives:        true,
  includeItemsFromAllDrives: true,
} as const;

// ── Folder operations ─────────────────────────────────────────────────────────

/**
 * Find a folder by name inside a parent. Returns the folder ID or null.
 */
export async function findFolder(
  name: string,
  parentId: string,
  driveId: string,
): Promise<string | null> {
  const drive = getDriveClient();
  const res = await driveCall(() => drive.files.list({
    ...SHARED_DRIVE_PARAMS,
    driveId,
    corpora:  'drive',
    q: `name = ${JSON.stringify(name)} and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
    fields:   'files(id)',
    pageSize: 1,
  }));
  return res.data.files?.[0]?.id ?? null;
}

/**
 * Create a folder inside a parent. Returns the new folder ID.
 */
export async function createFolder(
  name: string,
  parentId: string,
): Promise<string> {
  const drive = getDriveClient();
  const res = await driveCall(() => drive.files.create({
    ...SHARED_DRIVE_PARAMS,
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents:  [parentId],
    },
    fields: 'id',
  }));
  const id = res.data.id;
  if (!id) throw new Error(`[drive-client] Failed to create folder: ${name}`);
  return id;
}

/**
 * Idempotent — find or create a folder by name inside a parent.
 */
export async function ensureFolder(
  name: string,
  parentId: string,
  driveId: string,
): Promise<string> {
  const existing = await findFolder(name, parentId, driveId);
  if (existing) return existing;
  return createFolder(name, parentId);
}

// ── File operations ───────────────────────────────────────────────────────────

export interface UploadResult {
  fileId:      string;
  webViewLink: string;
}

/**
 * Upload a file buffer to a Drive folder. Returns fileId and webViewLink.
 */
export async function uploadFile(
  name:     string,
  mimeType: string,
  buffer:   Buffer,
  parentId: string,
): Promise<UploadResult> {
  const drive = getDriveClient();
  const res = await driveCall(() => drive.files.create({
    ...SHARED_DRIVE_PARAMS,
    requestBody: {
      name,
      parents: [parentId],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id, webViewLink',
  }));

  const fileId      = res.data.id;
  const webViewLink = res.data.webViewLink;
  if (!fileId || !webViewLink) {
    throw new Error(`[drive-client] Upload failed for: ${name}`);
  }
  return { fileId, webViewLink };
}

/**
 * Download a file by ID and return its contents as a Buffer.
 */
export async function downloadFile(fileId: string): Promise<Buffer> {
  const drive = getDriveClient();
  const res = await driveCall(() => drive.files.get(
    { ...SHARED_DRIVE_PARAMS, fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  ));
  return Buffer.from(res.data as ArrayBuffer);
}

/**
 * Export a Google Workspace file (Docs, Sheets, Slides, etc.) to a given MIME
 * type and return the result as a Buffer. Use this instead of downloadFile for
 * files with mimeType starting with 'application/vnd.google-apps.'.
 */
export async function exportFile(fileId: string, exportMimeType: string): Promise<Buffer> {
  const drive = getDriveClient();
  const res = await driveCall(() => drive.files.export(
    { fileId, mimeType: exportMimeType },
    { responseType: 'arraybuffer' },
  ));
  return Buffer.from(res.data as ArrayBuffer);
}

/**
 * Get file metadata (name, mimeType, parents, modifiedTime, webViewLink).
 */
export async function getFileMetadata(fileId: string): Promise<drive_v3.Schema$File> {
  const drive = getDriveClient();
  const res = await driveCall(() => drive.files.get({
    ...SHARED_DRIVE_PARAMS,
    fileId,
    fields: 'id, name, mimeType, parents, modifiedTime, webViewLink, trashed',
  }));
  return res.data;
}

/**
 * Move a file or folder to a new parent folder.
 * In Shared Drives, moves use addParents/removeParents query params, not requestBody.parents.
 */
export async function moveFile(
  fileId:      string,
  newParentId: string,
  oldParentId: string,
): Promise<void> {
  const drive = getDriveClient();
  await driveCall(() => drive.files.update({
    ...SHARED_DRIVE_PARAMS,
    fileId,
    addParents:    newParentId,
    removeParents: oldParentId,
    fields:        'id',
  }));
}

/**
 * List all direct children (files and subfolders) inside a folder.
 */
export async function listChildren(
  folderId: string,
  driveId:  string,
): Promise<drive_v3.Schema$File[]> {
  const drive = getDriveClient();
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const res: { data: drive_v3.Schema$FileList } = await driveCall(() => drive.files.list({
      ...SHARED_DRIVE_PARAMS,
      driveId,
      corpora:   'drive',
      q:         `'${folderId}' in parents and trashed = false`,
      fields:    'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink)',
      pageSize:  100,
      pageToken,
    }));
    files.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

// ── Changes / webhook ─────────────────────────────────────────────────────────

export interface WatchChannel {
  channelId:  string;
  resourceId: string;
  expiration: number; // Unix ms
}

/**
 * Register a push notification channel for all changes in a Shared Drive.
 * Drive will POST to webhookUrl whenever files change.
 * Channels expire — re-register before expiration (see DriveWatcherService).
 */
export async function watchDrive(
  driveId:    string,
  webhookUrl: string,
  token:      string,
  channelId:  string,
): Promise<WatchChannel> {
  const drive = getDriveClient();

  // Get a fresh start page token so we don't replay old history
  const tokenRes = await driveCall(() => drive.changes.getStartPageToken({
    ...SHARED_DRIVE_PARAMS,
    driveId,
  }));
  const startPageToken = tokenRes.data.startPageToken;
  if (!startPageToken) throw new Error('[drive-client] Failed to get start page token');

  const res = await driveCall(() => drive.changes.watch({
    ...SHARED_DRIVE_PARAMS,
    driveId,
    pageToken: startPageToken,
    requestBody: {
      id:         channelId,
      type:       'web_hook',
      address:    webhookUrl,
      token,
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000), // request 7 days (Unix ms)
    },
  }));

  const resourceId = res.data.resourceId;
  const expiration = res.data.expiration;
  if (!resourceId || !expiration) {
    throw new Error('[drive-client] Watch registration returned incomplete data');
  }

  return {
    channelId,
    resourceId,
    expiration: Number(expiration),
  };
}

/**
 * Stop a push notification channel.
 */
export async function stopWatch(channelId: string, resourceId: string): Promise<void> {
  const drive = getDriveClient();
  await driveCall(() => drive.channels.stop({
    requestBody: { id: channelId, resourceId },
  }));
}

export interface ChangesResult {
  changes:      drive_v3.Schema$Change[];
  newPageToken: string;
}

/**
 * Fetch changes since the last page token. Returns changes + updated token.
 * Pass the stored pageToken from the DB; save newPageToken back after processing.
 */
export async function getChanges(pageToken: string, driveId: string): Promise<ChangesResult> {
  const drive = getDriveClient();
  const changes: drive_v3.Schema$Change[] = [];
  let cursor = pageToken;

  // Paginate through all available change pages
  while (true) {
    const res = await driveCall(() => drive.changes.list({
      ...SHARED_DRIVE_PARAMS,
      driveId,
      pageToken: cursor,
      fields:    'nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, parents, modifiedTime, webViewLink, trashed))',
      pageSize:  100,
    }));

    changes.push(...(res.data.changes ?? []));

    if (res.data.nextPageToken) {
      cursor = res.data.nextPageToken;
    } else {
      cursor = res.data.newStartPageToken ?? cursor;
      break;
    }
  }

  return { changes, newPageToken: cursor };
}

/**
 * Get an initial page token for a Shared Drive (used when first setting up a watch).
 */
export async function getStartPageToken(driveId: string): Promise<string> {
  const drive = getDriveClient();
  const res = await driveCall(() => drive.changes.getStartPageToken({
    ...SHARED_DRIVE_PARAMS,
    driveId,
  }));
  const token = res.data.startPageToken;
  if (!token) throw new Error('[drive-client] Failed to get start page token');
  return token;
}
