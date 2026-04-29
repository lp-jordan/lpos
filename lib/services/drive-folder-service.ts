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
import { ensureFolder, findFolder, getDriveClient, listChildren, moveFile } from './drive-client';
import { getCoreDb } from '../store/core-db';

const DATA_DIR    = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const CACHE_PATH  = path.join(DATA_DIR, 'drive-folders.json');
const LPOS_ROOT_NAME = 'LPOS';

// ── Folder ID cache ───────────────────────────────────────────────────────────

interface FolderCache {
  rootFolderId:       string;
  clientFolders:      Record<string, string>;            // clientName → folderId
  projectFolders:     Record<string, ProjectFolderIds>;  // "{clientName}/{projectName}" → ids
  sharedAssetFolders: Record<string, string>;            // groupId → Drive folderId
}

export interface ProjectFolderIds {
  projectFolderId:  string;
  scripts:          string;
  transcripts:      string;
  assets:           string | null;  // null when project is in a link group
  workbooks:        string;
  assetLinkGroupId?: string;
}

export interface AssetLock {
  projectId: string;
  reason:    'merging' | 'provisioning' | 'unlinking';
  jobId:     string | null;
  lockedAt:  string;
}

function readCache(): FolderCache | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as FolderCache;
  } catch {
    return null;
  }
}

export function writeCache(cache: FolderCache): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

export function getCache(): FolderCache {
  const c = readCache();
  if (!c) return { rootFolderId: '', clientFolders: {}, projectFolders: {}, sharedAssetFolders: {} };
  if (!c.clientFolders) c.clientFolders = {};
  if (!c.sharedAssetFolders) c.sharedAssetFolders = {};
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
 * Returns a map of Drive folder ID → client name for all cached client folders.
 * Used by the Drive watcher to identify whether an unknown folder's parent
 * is a known client folder (i.e. the unknown folder is a project-level orphan).
 */
export function getClientFolderIdMap(): Record<string, string> {
  const cache = getCache();
  return Object.fromEntries(
    Object.entries(cache.clientFolders).map(([name, id]) => [id, name]),
  );
}

const STANDARD_SUBFOLDERS = new Set(['Scripts', 'Transcripts', 'Assets', 'Workbooks']);

/**
 * Moves any non-standard children of an orphaned folder into the Assets subfolder.
 * Standard subfolders (Scripts, Transcripts, Assets, Workbooks) are skipped —
 * ensureProjectFolders() will have already created them inside the adopted folder.
 */
export async function adoptOrphanedFolderContents(
  orphanedFolderId: string,
  assetsFolderId:   string,
  driveId:          string,
): Promise<void> {
  const children = await listChildren(orphanedFolderId, driveId);
  for (const child of children) {
    if (!child.id || !child.name || STANDARD_SUBFOLDERS.has(child.name)) continue;
    await moveFile(child.id, assetsFolderId, orphanedFolderId);
    console.log(`[drive-folders] adopted orphaned item into assets: ${child.name}`);
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

/**
 * Returns the Drive assets folder ID for a project.
 * When the project is in a link group, resolves through sharedAssetFolders.
 * Returns null if folders have not been initialised yet.
 */
export function resolveAssetsFolder(projectName: string, clientName: string): string | null {
  const cache = getCache();
  const ids = cache.projectFolders[`${clientName}/${projectName}`];
  if (!ids) return null;
  if (ids.assetLinkGroupId) {
    return cache.sharedAssetFolders[ids.assetLinkGroupId] ?? null;
  }
  return ids.assets;
}

/**
 * Returns the shared Drive folder ID for a link group, or null if not yet created.
 */
export function getSharedAssetsFolderId(groupId: string): string | null {
  return getCache().sharedAssetFolders[groupId] ?? null;
}

/**
 * Creates the shared assets folder for a link group directly under the client
 * folder (sibling to project folders). Named "[Client Name] (Shared)".
 * Writes the folder ID to the cache and returns it.
 */
export async function createSharedAssetsFolder(
  clientName: string,
  groupId:    string,
  driveId:    string,
): Promise<string> {
  const cache = getCache();
  const clientFolderId = cache.clientFolders[clientName];
  if (!clientFolderId) throw new Error(`[drive-folders] No client folder found for "${clientName}"`);

  const folderName = `${clientName} (Shared)`;
  const folderId   = await ensureFolder(folderName, clientFolderId, driveId);

  cache.sharedAssetFolders[groupId] = folderId;
  writeCache(cache);

  console.log(`[drive-folders] Shared assets folder ready for "${clientName}": ${folderId}`);
  return folderId;
}

/**
 * Provisions a new per-project Assets folder when a project is unlinked from a group.
 * Updates the folder cache. Returns the new folder ID.
 */
export async function provisionFreshAssetsFolder(
  projectName: string,
  clientName:  string,
  driveId:     string,
): Promise<string> {
  const cache = getCache();
  const key   = `${clientName}/${projectName}`;
  const ids   = cache.projectFolders[key];
  if (!ids) throw new Error(`[drive-folders] No cached folders for "${key}"`);

  const folderId = await ensureFolder('Assets', ids.projectFolderId, driveId);

  ids.assets = folderId;
  delete ids.assetLinkGroupId;
  cache.projectFolders[key] = ids;
  writeCache(cache);

  console.log(`[drive-folders] Fresh assets folder provisioned for "${clientName} / ${projectName}"`);
  return folderId;
}

/**
 * Attaches a project to a link group: updates the projects DB row and the
 * folder cache so resolveAssetsFolder() returns the shared folder going forward.
 */
export function attachProjectToGroup(
  projectId:   string,
  projectName: string,
  clientName:  string,
  groupId:     string,
): void {
  getCoreDb().prepare(
    `UPDATE projects SET asset_link_group_id = ?, updated_at = datetime('now') WHERE project_id = ?`,
  ).run(groupId, projectId);

  const cache = getCache();
  const key   = `${clientName}/${projectName}`;
  const ids   = cache.projectFolders[key];
  if (ids) {
    ids.assets          = null;
    ids.assetLinkGroupId = groupId;
    cache.projectFolders[key] = ids;
    writeCache(cache);
  }
}

/**
 * Detaches a project from its link group: clears the DB column and folder cache.
 * Call provisionFreshAssetsFolder() separately to give it a new Drive folder.
 */
export function detachProjectFromGroup(
  projectId:   string,
  projectName: string,
  clientName:  string,
): void {
  getCoreDb().prepare(
    `UPDATE projects SET asset_link_group_id = NULL, updated_at = datetime('now') WHERE project_id = ?`,
  ).run(projectId);

  const cache = getCache();
  const key   = `${clientName}/${projectName}`;
  const ids   = cache.projectFolders[key];
  if (ids) {
    delete ids.assetLinkGroupId;
    cache.projectFolders[key] = ids;
    writeCache(cache);
  }
}

// ── Asset link locks ──────────────────────────────────────────────────────────

export function lockProject(
  projectId: string,
  reason:    'merging' | 'provisioning' | 'unlinking',
  jobId?:    string,
): void {
  getCoreDb().prepare(`
    INSERT OR REPLACE INTO asset_link_locks (project_id, reason, job_id, locked_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(projectId, reason, jobId ?? null);
}

export function unlockProject(projectId: string): void {
  getCoreDb().prepare(`DELETE FROM asset_link_locks WHERE project_id = ?`).run(projectId);
}

/**
 * Deletes the link group record (and removes it from the folder cache) if no
 * projects still reference it. Called after detaching a project to clean up
 * orphaned groups. The shared Drive folder is intentionally left in place —
 * it becomes untethered but remains accessible in Drive.
 */
export function cleanupGroupIfEmpty(groupId: string): void {
  const db = getCoreDb();
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM projects WHERE asset_link_group_id = ?`,
  ).get(groupId) as { n: number } | undefined;

  if ((row?.n ?? 1) > 0) return;

  db.prepare(`DELETE FROM asset_link_groups WHERE group_id = ?`).run(groupId);

  const cache = getCache();
  delete cache.sharedAssetFolders[groupId];
  writeCache(cache);

  console.log(`[drive-folders] Group ${groupId} has no remaining members — record removed`);
}

export function getProjectLock(projectId: string): AssetLock | null {
  const row = getCoreDb().prepare(
    `SELECT project_id, reason, job_id, locked_at FROM asset_link_locks WHERE project_id = ?`,
  ).get(projectId) as { project_id: string; reason: string; job_id: string | null; locked_at: string } | undefined;
  if (!row) return null;
  return {
    projectId: row.project_id,
    reason:    row.reason as AssetLock['reason'],
    jobId:     row.job_id,
    lockedAt:  row.locked_at,
  };
}
