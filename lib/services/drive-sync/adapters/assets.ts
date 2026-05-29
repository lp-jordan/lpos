/**
 * Assets adapter — metadata-only.
 *
 * Drive is the file store; LPOS only indexes Assets-folder files in drive_assets
 * (no local bytes). A pull indexes the new file; a Drive delete drops the index
 * row(s) (the Drive file itself is recoverable from Drive Trash).
 */

import { randomUUID } from 'node:crypto';
import {
  upsertDriveAsset,
  getDriveAssetsByParent,
  deleteDriveAssetByEntityId,
  type DriveAsset,
} from '@/lib/store/drive-sync-db';
import { getProjectStore } from '@/lib/services/container';
import type {
  FolderSyncAdapter,
  DrivePulledFile,
  FolderContext,
  SyncEngineContext,
} from '../types';

/**
 * Recursively drop an asset's index rows. Drive trashes a folder's whole
 * subtree, so descendant rows must be removed too. Shared by the engine delete
 * path and the assets DELETE route so both stay consistent.
 */
export function purgeDriveAssetSubtree(asset: DriveAsset): void {
  if (asset.isFolder) {
    for (const child of getDriveAssetsByParent(asset.driveFileId)) {
      purgeDriveAssetSubtree(child);
    }
  }
  deleteDriveAssetByEntityId(asset.entityId);
}

export const assetsAdapter: FolderSyncAdapter = {
  folderType: 'assets',
  entityType: 'asset',
  kind:       'metadata-only',

  async onDrivePull(file: DrivePulledFile, ctx: FolderContext, engine: SyncEngineContext): Promise<void> {
    try {
      const entityId    = randomUUID();
      const webViewLink = file.webViewLink ?? '';

      upsertDriveAsset({
        entityType:    'asset',
        entityId,
        projectId:     ctx.projectId,
        driveFileId:   file.fileId,
        driveFolderId: file.parentId,
        name:          file.name,
        mimeType:      file.mimeType,
        webViewLink,
        isFolder:      false,
        parentDriveId: file.parentId,
        fileSize:      file.fileSize ?? undefined,
        modifiedAt:    file.modifiedAt ?? undefined,
      });

      engine.io.emit('drive:file-synced', {
        entityType: 'asset',
        entityId,
        projectId:  ctx.projectId,
        name:       file.name,
      });

      getProjectStore().touch(ctx.projectId);
      console.log(`[drive-sync] indexed asset: ${file.name} → ${ctx.projectName}`);
    } catch (err) {
      console.error(`[drive-sync] failed to index asset ${file.fileId}:`, err);
    }
  },

  async onDriveDelete(asset: DriveAsset, engine: SyncEngineContext): Promise<void> {
    // Metadata-only: no local bytes. The Drive file is now in Drive Trash
    // (recoverable); just remove the LPOS index row(s).
    purgeDriveAssetSubtree(asset);
    engine.io.emit('drive:file-synced', {
      entityType: 'asset',
      projectId:  asset.projectId,
      name:       asset.name,
    });
    console.log(`[drive-sync] asset removed via Drive delete: ${asset.name}`);
  },
};
