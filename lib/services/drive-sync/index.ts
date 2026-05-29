/**
 * Drive sync engine — entry point.
 *
 * Registers the built-in folder adapters (on import) and exposes the engine's
 * public surface: adapter lookups (used by the watcher's pull path) and
 * handleDriveDelete (used by the watcher's delete path).
 *
 * P1 ships Assets + Scripts. Transcripts, Workbooks and Photos plug in here in
 * later phases by registering their own adapters.
 */

import { getDriveAssetByFileId } from '@/lib/store/drive-sync-db';
import {
  registerAdapter,
  getAdapterByEntityType,
  getAdapterByFolderType,
} from './registry';
import { assetsAdapter } from './adapters/assets';
import { scriptsAdapter } from './adapters/scripts';
import type { SyncEngineContext } from './types';

let _registered = false;
function ensureRegistered(): void {
  if (_registered) return;
  registerAdapter(assetsAdapter);
  registerAdapter(scriptsAdapter);
  _registered = true;
}
ensureRegistered();

export { getAdapterByFolderType, getAdapterByEntityType } from './registry';
export { purgeDriveAssetSubtree } from './adapters/assets';
export type {
  FolderType,
  FolderContext,
  DrivePulledFile,
  SyncEngineContext,
  SyncKind,
  FolderSyncAdapter,
} from './types';

/**
 * Mirror a Drive deletion into LPOS. The change feed gives us a Drive file ID;
 * we look it up in drive_assets — if LPOS never synced it, the lookup misses
 * and we do nothing (so this only ever fires for files LPOS actually owns, and
 * never on unrelated Drive activity or on a missing/partial listing). When
 * found, the owning adapter soft-deletes the local counterpart.
 */
export async function handleDriveDelete(fileId: string, engine: SyncEngineContext): Promise<void> {
  ensureRegistered();
  const asset = getDriveAssetByFileId(fileId);
  if (!asset) return;                              // unknown file — ignore (safeguard)
  const adapter = getAdapterByEntityType(asset.entityType);
  if (!adapter) return;                            // type not managed yet (transcript/media)
  await adapter.onDriveDelete(asset, engine);
}
