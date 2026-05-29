/**
 * Scripts adapter — local-bytes.
 *
 * Scripts are downloaded to disk (data/projects/<id>/scripts/), text-extracted,
 * and registered in the scripts registry. A pull mirrors the create logic that
 * previously lived in the watcher; a Drive delete soft-deletes the local script
 * (bytes moved to the project .trash dir) and drops the registry + index rows.
 */

import fs   from 'node:fs';
import path from 'node:path';

import { downloadFile } from '../../drive-client';
import { extractAndSave } from '../../script-extractor';
import {
  registerScript,
  patchScript,
  removeScript,
  scriptsDir,
} from '@/lib/store/scripts-registry';
import {
  upsertDriveAsset,
  deleteDriveAssetByEntityId,
  type DriveAsset,
} from '@/lib/store/drive-sync-db';
import { softDeleteLocalFile } from '../local-trash';
import type {
  FolderSyncAdapter,
  DrivePulledFile,
  FolderContext,
  SyncEngineContext,
} from '../types';

const ALLOWED_SCRIPT_EXTS = new Set(['.docx', '.pdf', '.txt', '.doc']);

export const scriptsAdapter: FolderSyncAdapter = {
  folderType: 'scripts',
  entityType: 'script',
  kind:       'local-bytes',

  async onDrivePull(file: DrivePulledFile, ctx: FolderContext, engine: SyncEngineContext): Promise<void> {
    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED_SCRIPT_EXTS.has(ext)) return;

    try {
      const webViewLink = file.webViewLink ?? '';
      const buffer = await downloadFile(file.fileId);
      const dir    = scriptsDir(ctx.projectId);
      fs.mkdirSync(dir, { recursive: true });

      const script = registerScript({
        projectId:        ctx.projectId,
        name:             path.basename(file.name, ext),
        originalFilename: file.name,
        filePath:         '',
        fileSize:         buffer.length,
        mimeType:         file.mimeType,
      });

      const finalPath = path.join(dir, `${script.scriptId}${ext}`);
      fs.writeFileSync(finalPath, buffer);

      patchScript(ctx.projectId, script.scriptId, {
        filePath:        finalPath,
        driveFileId:     file.fileId,
        driveWebViewUrl: webViewLink,
        driveSource:     true,
      });

      upsertDriveAsset({
        entityType:    'script',
        entityId:      script.scriptId,
        projectId:     ctx.projectId,
        driveFileId:   file.fileId,
        driveFolderId: file.parentId,
        name:          file.name,
        mimeType:      file.mimeType,
        webViewLink,
        isFolder:      false,
        parentDriveId: file.parentId,
        localPath:     finalPath,
        fileSize:      file.fileSize ?? undefined,
        modifiedAt:    file.modifiedAt ?? undefined,
      });

      void extractAndSave(ctx.projectId, script.scriptId, finalPath, ext);

      engine.io.emit('drive:file-synced', {
        entityType: 'script',
        entityId:   script.scriptId,
        projectId:  ctx.projectId,
        name:       file.name,
      });

      console.log(`[drive-sync] pulled script: ${file.name} → ${ctx.projectName}`);
    } catch (err) {
      console.error(`[drive-sync] failed to pull script ${file.fileId}:`, err);
    }
  },

  async onDriveDelete(asset: DriveAsset, engine: SyncEngineContext): Promise<void> {
    // local-bytes: move the script (and its extracted-text sidecar) to the
    // project .trash dir, then drop the registry entry + index row. Recoverable
    // from .trash and from Drive Trash.
    try {
      if (asset.localPath) {
        softDeleteLocalFile(asset.projectId, asset.localPath);
        const extracted = path.join(path.dirname(asset.localPath), `${asset.entityId}.extracted.txt`);
        softDeleteLocalFile(asset.projectId, extracted);
      }
      removeScript(asset.projectId, asset.entityId);
      deleteDriveAssetByEntityId(asset.entityId);

      engine.io.emit('drive:file-synced', {
        entityType: 'script',
        entityId:   asset.entityId,
        projectId:  asset.projectId,
        name:       asset.name,
      });

      console.log(`[drive-sync] script removed via Drive delete: ${asset.name}`);
    } catch (err) {
      console.error(`[drive-sync] failed to soft-delete script ${asset.entityId}:`, err);
    }
  },
};
