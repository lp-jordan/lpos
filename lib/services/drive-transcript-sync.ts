/**
 * Drive ↔ Transcript sync helpers
 *
 * pushTranscriptToDrive — called when a transcription job completes; uploads
 *   the .txt transcript to the project's Transcripts folder in Drive.
 *
 * Fire-and-forget — callers void the promise.
 * Errors are logged but never surfaced to the user (Drive is best-effort).
 */

import fs   from 'node:fs';
import path from 'node:path';

import { uploadFile } from './drive-client';
import {
  ensureProjectFolders,
  getCachedRootFolderId,
  ensureLposRootFolder,
} from './drive-folder-service';
import { getDriveAssetByEntityId, upsertDriveAsset } from '@/lib/store/drive-sync-db';
import { getProjectStore } from '@/lib/services/container';
import { listProjectTranscripts, resolveTranscriptDisplayName } from '@/lib/transcripts/store';

const DRIVE_ID  = () => process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim() ?? '';
const DATA_DIR  = () => process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

/**
 * Upload a completed transcript (.txt) to Drive and record it in drive_assets.
 *
 * Safe to call even if Drive is not configured — exits silently.
 */
export async function pushTranscriptToDrive(
  projectId: string,
  jobId:     string,
): Promise<void> {
  const driveId = DRIVE_ID();
  if (!driveId) return;

  try {
    const project = getProjectStore().getById(projectId);
    if (!project) return;

    // Skip if already synced
    if (getDriveAssetByEntityId('transcript', jobId)) return;

    // Locate the transcript .txt file
    const filePath = path.join(DATA_DIR(), 'projects', projectId, 'transcripts', `${jobId}.txt`);
    if (!fs.existsSync(filePath)) return;

    // Ensure root + project folders exist
    let rootId = getCachedRootFolderId();
    if (!rootId) rootId = await ensureLposRootFolder(driveId);

    const folders      = await ensureProjectFolders(driveId, rootId, project.name, project.clientName);
    const displayName  = resolveTranscriptDisplayName(projectId, jobId);
    const fileName     = `${displayName}.txt`;
    const buffer       = fs.readFileSync(filePath);

    const { fileId, webViewLink } = await uploadFile(
      fileName,
      'text/plain',
      buffer,
      folders.transcripts,
    );

    upsertDriveAsset({
      entityType:    'transcript',
      entityId:      jobId,
      projectId,
      driveFileId:   fileId,
      driveFolderId: folders.transcripts,
      name:          fileName,
      mimeType:      'text/plain',
      webViewLink,
    });

    console.log(`[drive-transcript-sync] pushed transcript to Drive: ${fileName}`);
  } catch (err) {
    console.error(`[drive-transcript-sync] failed to push transcript ${jobId} to Drive:`, err);
  }
}

/**
 * Push all existing local transcripts across all projects to Drive.
 * Skips any already synced. Used by the admin scan endpoint.
 * Returns the count of transcripts pushed.
 */
export async function pushAllExistingTranscripts(): Promise<number> {
  const driveId = DRIVE_ID();
  if (!driveId) return 0;

  const projects = getProjectStore().getAll();
  let count = 0;

  for (const project of projects) {
    const transcripts = listProjectTranscripts(project.projectId);
    for (const t of transcripts) {
      await pushTranscriptToDrive(project.projectId, t.jobId);
      count++;
    }
  }

  console.log(`[drive-transcript-sync] batch push complete — ${count} transcripts processed`);
  return count;
}
