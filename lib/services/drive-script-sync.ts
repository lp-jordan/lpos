/**
 * Drive ↔ Script sync helpers
 *
 * pushScriptToDrive  — called after a script is uploaded to LPOS; mirrors the
 *                      file to the correct Drive project folder and records the
 *                      Drive file ID back into the script registry.
 *
 * These are fire-and-forget helpers — callers void the promise.
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
import { upsertDriveAsset } from '@/lib/store/drive-sync-db';
import { patchScript, getScript } from '@/lib/store/scripts-registry';
import { getProjectStore } from '@/lib/services/container';

const DRIVE_ID = () => process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim() ?? '';

/**
 * Upload a script file to Drive and record the file ID in the script registry.
 *
 * Safe to call even if Drive is not configured — exits silently.
 */
export async function pushScriptToDrive(
  projectId: string,
  scriptId:  string,
  filePath:  string,
  name:      string,
): Promise<void> {
  const driveId = DRIVE_ID();
  if (!driveId) return;

  try {
    const project = getProjectStore().getById(projectId);
    if (!project) return;

    const script = getScript(projectId, scriptId);
    if (!script) return;

    // Skip if already synced to Drive
    if (script.driveFileId) return;

    // Ensure root + project folders exist
    let rootId = getCachedRootFolderId();
    if (!rootId) rootId = await ensureLposRootFolder(driveId);

    const folders = await ensureProjectFolders(driveId, rootId, project.name, project.clientName);

    const buffer   = fs.readFileSync(filePath);
    const mimeType = script.mimeType || guessMimeFromPath(filePath);
    const fileName = name + path.extname(filePath);

    const { fileId, webViewLink } = await uploadFile(
      fileName,
      mimeType,
      buffer,
      folders.scripts,
    );

    // Record Drive file ID back into the script
    patchScript(projectId, scriptId, {
      driveFileId:     fileId,
      driveWebViewUrl: webViewLink,
    });

    upsertDriveAsset({
      entityType:   'script',
      entityId:     scriptId,
      projectId,
      driveFileId:  fileId,
      driveFolderId: folders.scripts,
      name:         fileName,
      mimeType,
      webViewLink,
    });

    console.log(`[drive-script-sync] pushed script to Drive: ${fileName}`);
  } catch (err) {
    console.error(`[drive-script-sync] failed to push script ${scriptId} to Drive:`, err);
  }
}

function guessMimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pdf':  'application/pdf',
    '.txt':  'text/plain',
    '.doc':  'application/msword',
  };
  return map[ext] ?? 'application/octet-stream';
}
