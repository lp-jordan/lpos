/**
 * Merge Worker
 *
 * Executes the async merge of a source project's assets folder into the
 * shared link-group folder. Driven by rows in the asset_merge_jobs table.
 *
 * State machine:
 *   pending → scanning → (conflicts?) awaiting_resolution → merging → completed
 *                                                                    → failed
 *
 * Entry points:
 *   runMergeJob(jobId)         — start or resume a job
 *   resumeAfterResolution(jobId) — called by the resolve API after the user
 *                                  submits conflict resolutions
 */

import { getCoreDb } from '../store/core-db';
import {
  copyFile,
  deleteFile,
  listChildren,
  moveFile,
  renameFile,
} from './drive-client';
import {
  attachProjectToGroup,
  getSharedAssetsFolderId,
  resolveAssetsFolder,
  unlockProject,
} from './drive-folder-service';
import { getProjectStore } from './container';

// ── Types ─────────────────────────────────────────────────────────────────────

type MergeJobStatus =
  | 'pending'
  | 'scanning'
  | 'awaiting_resolution'
  | 'merging'
  | 'completed'
  | 'failed';

interface MergeJobRow {
  job_id:             string;
  group_id:           string;
  source_project_id:  string;
  status:             MergeJobStatus;
  conflict_payload:   string | null;
  resolution_payload: string | null;
  error_message:      string | null;
  created_at:         string;
  updated_at:         string;
  completed_at:       string | null;
}

export interface ConflictFile {
  filename:        string;
  sourceFileId:    string;
  sourceModifiedAt: string | null;
  sourceSize:      number | null;
  targetFileId:    string;
  targetModifiedAt: string | null;
  targetSize:      number | null;
}

export type ConflictResolution = 'keep_source' | 'keep_target' | 'keep_both';

export interface ResolutionMap {
  resolutions: Record<string, ConflictResolution>;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// When merging folders with many items, a short pause between Drive API calls
// keeps the request rate comfortably below Drive's 1000 req/100 s quota.
const THROTTLE_THRESHOLD = 30;
const THROTTLE_MS        = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isDrive404(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown };
  return e.code === 404 || e.status === 404;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function loadJob(jobId: string): MergeJobRow | undefined {
  return getCoreDb()
    .prepare(`SELECT * FROM asset_merge_jobs WHERE job_id = ?`)
    .get(jobId) as MergeJobRow | undefined;
}

function setStatus(jobId: string, status: MergeJobStatus, extra?: {
  conflictPayload?:   string;
  errorMessage?:      string;
  markCompleted?:     boolean;
}): void {
  const db = getCoreDb();
  const parts = [`status = ?`, `updated_at = datetime('now')`];
  const vals: (string | null)[] = [status];

  if (extra?.conflictPayload !== undefined) {
    parts.push(`conflict_payload = ?`);
    vals.push(extra.conflictPayload);
  }
  if (extra?.errorMessage !== undefined) {
    parts.push(`error_message = ?`);
    vals.push(extra.errorMessage);
  }
  if (extra?.markCompleted) {
    parts.push(`completed_at = datetime('now')`);
  }

  vals.push(jobId);
  db.prepare(`UPDATE asset_merge_jobs SET ${parts.join(', ')} WHERE job_id = ?`).run(...vals);
}

// ── Public entry points ───────────────────────────────────────────────────────

/**
 * Start or resume a merge job. Safe to call multiple times — idempotent on
 * completed/failed/awaiting_resolution jobs (returns immediately).
 */
export async function runMergeJob(jobId: string): Promise<void> {
  const job = loadJob(jobId);
  if (!job) {
    console.error(`[merge-worker] Job not found: ${jobId}`);
    return;
  }

  // Already terminal or waiting on user input — nothing to do
  if (['completed', 'failed', 'awaiting_resolution'].includes(job.status)) return;

  const driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim();
  if (!driveId) {
    setStatus(jobId, 'failed', { errorMessage: 'GOOGLE_DRIVE_SHARED_DRIVE_ID not configured' });
    return;
  }

  try {
    const project = getProjectStore().getById(job.source_project_id);
    if (!project) throw new Error(`Source project not found: ${job.source_project_id}`);

    const sourceAssetsFolderId = resolveAssetsFolder(project.name, project.clientName);
    if (!sourceAssetsFolderId) throw new Error(`Assets folder not found for project "${project.name}"`);

    const sharedFolderId = getSharedAssetsFolderId(job.group_id);
    if (!sharedFolderId) throw new Error(`Shared folder not in cache for group ${job.group_id}`);

    // ── Scanning phase ────────────────────────────────────────────────────────
    if (job.status !== 'merging') {
      setStatus(jobId, 'scanning');

      const [sourceItems, sharedItems] = await Promise.all([
        listChildren(sourceAssetsFolderId, driveId),
        listChildren(sharedFolderId, driveId),
      ]);

      const sharedByName = new Map(
        sharedItems.filter(f => f.name).map(f => [f.name!, f]),
      );

      const conflicts: ConflictFile[] = [];
      for (const item of sourceItems) {
        if (!item.id || !item.name) continue;
        const target = sharedByName.get(item.name);
        if (target?.id) {
          conflicts.push({
            filename:        item.name,
            sourceFileId:    item.id,
            sourceModifiedAt: item.modifiedTime ?? null,
            sourceSize:      item.size ? Number(item.size) : null,
            targetFileId:    target.id,
            targetModifiedAt: target.modifiedTime ?? null,
            targetSize:      target.size ? Number(target.size) : null,
          });
        }
      }

      if (conflicts.length > 0) {
        setStatus(jobId, 'awaiting_resolution', {
          conflictPayload: JSON.stringify(conflicts),
        });
        console.log(`[merge-worker] Job ${jobId} paused — ${conflicts.length} conflict(s) need resolution`);
        return;
      }

      setStatus(jobId, 'merging');
    }

    // ── Merging phase ─────────────────────────────────────────────────────────
    await executeMerge(jobId, sourceAssetsFolderId, sharedFolderId, driveId);

    // Attach project to group in DB + cache, release lock
    attachProjectToGroup(job.source_project_id, project.name, project.clientName, job.group_id);
    unlockProject(job.source_project_id);

    setStatus(jobId, 'completed', { markCompleted: true });
    console.log(`[merge-worker] Job ${jobId} completed — "${project.name}" merged into group ${job.group_id}`);

    // Push updated project data (assetLinkGroupId set, assetMergeLocked cleared)
    getProjectStore().broadcastAll();

    // Run the next pending job in this group (serial chaining)
    const nextJob = getCoreDb().prepare(`
      SELECT job_id FROM asset_merge_jobs
      WHERE group_id = ? AND status = 'pending'
      ORDER BY created_at ASC LIMIT 1
    `).get(job.group_id) as { job_id: string } | undefined;

    if (nextJob) {
      runMergeJob(nextJob.job_id).catch((err: unknown) =>
        console.error(`[merge-worker] Next job ${nextJob.job_id} in group ${job.group_id} failed:`, err),
      );
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[merge-worker] Job ${jobId} failed:`, err);
    setStatus(jobId, 'failed', { errorMessage: msg });
    // Lock is intentionally kept — manual recovery required.
    // Broadcast so the project card shows the locked chip immediately.
    getProjectStore().broadcastAll();
  }
}

/**
 * Called by the resolve API after the user submits conflict resolutions.
 * Writes the resolution payload, transitions to merging, and resumes.
 */
export async function resumeAfterResolution(
  jobId:       string,
  resolutions: ResolutionMap,
): Promise<void> {
  getCoreDb().prepare(`
    UPDATE asset_merge_jobs
    SET status = 'merging', resolution_payload = ?, updated_at = datetime('now')
    WHERE job_id = ? AND status = 'awaiting_resolution'
  `).run(JSON.stringify(resolutions), jobId);

  // Fire-and-forget so the API response returns immediately
  runMergeJob(jobId).catch(err =>
    console.error(`[merge-worker] resumeAfterResolution failed for ${jobId}:`, err),
  );
}

// ── Core merge logic ──────────────────────────────────────────────────────────

async function executeMerge(
  jobId:               string,
  sourceAssetsFolderId: string,
  sharedFolderId:       string,
  driveId:              string,
): Promise<void> {
  const job = loadJob(jobId)!;
  const resolutions: ResolutionMap = job.resolution_payload
    ? (JSON.parse(job.resolution_payload) as ResolutionMap)
    : { resolutions: {} };

  // If the source folder is already gone, a previous attempt may have completed the
  // file moves and deleted the folder before the job could be marked done. Treat
  // this as a successful merge — the caller will finalize the DB state.
  let sourceItems: Awaited<ReturnType<typeof listChildren>>;
  try {
    sourceItems = await listChildren(sourceAssetsFolderId, driveId);
  } catch (err) {
    if (isDrive404(err)) {
      console.log(`[merge-worker] Job ${jobId}: source folder already gone — assuming previously merged`);
      return;
    }
    throw err;
  }

  const sharedItems = await listChildren(sharedFolderId, driveId);
  const sharedByName = new Map(
    sharedItems.filter(f => f.name).map(f => [f.name!, f]),
  );

  const throttle = sourceItems.length > THROTTLE_THRESHOLD ? THROTTLE_MS : 0;

  for (const item of sourceItems) {
    if (!item.id || !item.name) continue;

    const target     = sharedByName.get(item.name);
    const resolution = resolutions.resolutions[item.name];

    try {
      if (!target?.id) {
        await moveFile(item.id, sharedFolderId, sourceAssetsFolderId);
      } else {
        const res = resolution ?? 'keep_target';

        if (res === 'keep_source') {
          await deleteFile(target.id);
          await moveFile(item.id, sharedFolderId, sourceAssetsFolderId);

        } else if (res === 'keep_target') {
          await deleteFile(item.id);

        } else {
          // keep_both — move source under a " (1)" name
          if (item.mimeType === FOLDER_MIME) {
            await renameFile(item.id, `${item.name} (1)`);
            await moveFile(item.id, sharedFolderId, sourceAssetsFolderId);
          } else {
            const dotIndex = item.name.lastIndexOf('.');
            const base = dotIndex >= 0 ? item.name.slice(0, dotIndex) : item.name;
            const ext  = dotIndex >= 0 ? item.name.slice(dotIndex)   : '';
            await copyFile(item.id, sharedFolderId, `${base} (1)${ext}`);
            await deleteFile(item.id);
          }
        }
      }
    } catch (err) {
      // Item disappeared between list and operation — already moved or deleted by a
      // concurrent process or previous attempt. Skip and continue.
      if (isDrive404(err)) {
        console.warn(`[merge-worker] Job ${jobId}: skipping missing item "${item.name}" (${item.id})`);
        continue;
      }
      throw err;
    }

    if (throttle) await sleep(throttle);
  }

  // Delete the now-empty source assets folder.
  // Tolerate 404 — a previous attempt may have already deleted it.
  try {
    await deleteFile(sourceAssetsFolderId);
  } catch (err) {
    if (!isDrive404(err)) throw err;
    console.log(`[merge-worker] Job ${jobId}: source folder already deleted — continuing`);
  }
}
