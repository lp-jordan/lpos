/**
 * Drive Folder Service
 *
 * Ensures the LPOS folder tree exists in the Shared Team Drive.
 * Called once on DriveWatcherService.start() and on-demand when a new
 * project first syncs a file to Drive.
 *
 * Folder structure:
 *   /LPOS/
 *     {clientName}/
 *       {projectName}/
 *         Scripts/
 *         Transcripts/
 *         Assets/
 *         Workbooks/
 *     Shared Resources/
 *
 * Folder IDs are cached in data/drive-folders.json to avoid hitting the
 * Drive API on every boot. The cache is invalidated if a folder is not
 * found on a subsequent lookup.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { ensureFolder, findFolder, getDriveClient } from './drive-client';

const DATA_DIR    = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const CACHE_PATH  = path.join(DATA_DIR, 'drive-folders.json');
const LPOS_ROOT_NAME = 'LPOS';

// ── Folder ID cache ───────────────────────────────────────────────────────────

interface FolderCache {
  rootFolderId: string;
  clientFolders: Record<string, string>;          // clientName → folderId
  projectFolders: Record<string, ProjectFolderIds>; // "{clientName}/{projectName}" → ids
}

export interface ProjectFolderIds {
  projectFolderId: string; // the /LPOS/{client}/{project}/ folder itself
  scripts:         string;
  transcripts:     string;
  assets:          string;
  workbooks:       string;
}

function readCache(): FolderCache | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as FolderCache;
  } catch {
    return null;
  }
}

function writeCache(cache: FolderCache): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function getCache(): FolderCache {
  const c = readCache();
  if (!c) return { rootFolderId: '', clientFolders: {}, projectFolders: {} };
  // Migrate older caches that pre-date the clientFolders field
  if (!c.clientFolders) c.clientFolders = {};
  return c;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ensures the /LPOS root folder exists in the Shared Drive.
 * Returns the root folder ID.
 */
export async function ensureLposRootFolder(driveId: string): Promise<string> {
  const cache = getCache();

  if (cache.rootFolderId) {
    // Verify it still exists
    const existing = await findFolder(LPOS_ROOT_NAME, driveId, driveId);
    if (existing) return existing;
    // Cache is stale — clear and recreate
    cache.rootFolderId = '';
    writeCache(cache);
  }

  const rootId = await ensureFolder(LPOS_ROOT_NAME, driveId, driveId);

  // Also ensure the Shared Resources folder under root
  await ensureFolder('Shared Resources', rootId, driveId);

  cache.rootFolderId = rootId;
  writeCache(cache);

  console.log(`[drive-folders] LPOS root folder: ${rootId}`);
  return rootId;
}

/**
 * Ensures the per-project subfolder tree exists under the LPOS root.
 * Creates /LPOS/{clientName}/{projectName}/{Scripts,Transcripts,Assets,Workbooks}.
 * Returns the four child folder IDs.
 *
 * Creates on demand — call this the first time a project syncs a file.
 */
export async function ensureProjectFolders(
  driveId:      string,
  rootFolderId: string,
  projectName:  string,
  clientName:   string,
): Promise<ProjectFolderIds> {
  const cache    = getCache();
  const cacheKey = `${clientName}/${projectName}`;
  const cached   = cache.projectFolders[cacheKey];

  if (cached) return cached;

  // Ensure /LPOS/{clientName}/ exists (cached separately)
  let clientFolderId = cache.clientFolders[clientName];
  if (!clientFolderId) {
    clientFolderId = await ensureFolder(clientName, rootFolderId, driveId);
    cache.clientFolders[clientName] = clientFolderId;
    writeCache(cache);
  }

  // Create /LPOS/{clientName}/{projectName}/
  const projectFolderId = await ensureFolder(projectName, clientFolderId, driveId);

  // Create the four subfolders in parallel
  const [scripts, transcripts, assets, workbooks] = await Promise.all([
    ensureFolder('Scripts',     projectFolderId, driveId),
    ensureFolder('Transcripts', projectFolderId, driveId),
    ensureFolder('Assets',      projectFolderId, driveId),
    ensureFolder('Workbooks',   projectFolderId, driveId),
  ]);

  const ids: ProjectFolderIds = { projectFolderId, scripts, transcripts, assets, workbooks };

  cache.projectFolders[cacheKey] = ids;
  writeCache(cache);

  console.log(`[drive-folders] Project folders created for "${clientName} / ${projectName}"`);
  return ids;
}

/**
 * Returns cached folder IDs for a project, or null if not yet created.
 * Does not hit the Drive API.
 */
export function getCachedProjectFolders(projectName: string, clientName: string): ProjectFolderIds | null {
  return readCache()?.projectFolders[`${clientName}/${projectName}`] ?? null;
}

/**
 * Returns the cached LPOS root folder ID, or null if not yet set up.
 */
export function getCachedRootFolderId(): string | null {
  const id = readCache()?.rootFolderId;
  return id || null;
}

/**
 * Invalidates the folder cache for a specific project (e.g. after a project rename).
 */
export function invalidateProjectFolderCache(projectName: string, clientName: string): void {
  const cache = getCache();
  delete cache.projectFolders[`${clientName}/${projectName}`];
  writeCache(cache);
}

/**
 * Renames a project folder in Drive and updates the local cache key.
 * Fire-and-forget safe — logs errors but does not throw.
 */
export async function renameProjectFolder(
  driveId:        string,
  clientName:     string,
  oldProjectName: string,
  newProjectName: string,
): Promise<void> {
  const cache    = getCache();
  const oldKey   = `${clientName}/${oldProjectName}`;
  const ids      = cache.projectFolders[oldKey];
  if (!ids) {
    console.warn(`[drive-folders] no cached folder for "${oldKey}" — skipping rename`);
    return;
  }

  try {
    await getDriveClient().files.update({
      fileId:            ids.projectFolderId,
      supportsAllDrives: true,
      requestBody:       { name: newProjectName },
      fields:            'id, name',
    });

    // Re-key cache entry
    const newKey = `${clientName}/${newProjectName}`;
    cache.projectFolders[newKey] = ids;
    delete cache.projectFolders[oldKey];
    writeCache(cache);

    console.log(`[drive-folders] Renamed Drive folder "${oldProjectName}" → "${newProjectName}"`);
  } catch (err) {
    console.error(`[drive-folders] Failed to rename Drive folder for "${oldProjectName}":`, err);
  }
}

/**
 * Ensures Drive folders exist for every project in the provided list.
 * Idempotent — safe to re-run. Used by the admin backfill endpoint.
 * Returns the count of projects processed.
 */
export async function ensureAllProjectFolders(
  driveId:      string,
  rootFolderId: string,
  projects:     { name: string; clientName: string }[],
): Promise<number> {
  let count = 0;
  for (const project of projects) {
    await ensureProjectFolders(driveId, rootFolderId, project.name, project.clientName);
    count++;
  }
  return count;
}
