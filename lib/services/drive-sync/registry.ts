/**
 * Drive sync adapter registry.
 *
 * Adapters are looked up two ways: by FolderType (for the create/pull path,
 * where the watcher knows which folder a file landed in) and by
 * DriveEntityType (for the delete path, where we only have the drive_assets row
 * for the removed file).
 */

import type { DriveEntityType } from '@/lib/store/drive-sync-db';
import type { FolderType, FolderSyncAdapter } from './types';

const byFolderType = new Map<FolderType, FolderSyncAdapter>();
const byEntityType = new Map<DriveEntityType, FolderSyncAdapter>();

export function registerAdapter(adapter: FolderSyncAdapter): void {
  byFolderType.set(adapter.folderType, adapter);
  byEntityType.set(adapter.entityType, adapter);
}

export function getAdapterByFolderType(folderType: FolderType): FolderSyncAdapter | undefined {
  return byFolderType.get(folderType);
}

export function getAdapterByEntityType(entityType: DriveEntityType): FolderSyncAdapter | undefined {
  return byEntityType.get(entityType);
}
