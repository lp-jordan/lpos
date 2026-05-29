/**
 * Drive sync engine — shared types.
 *
 * The engine expresses each synced Drive subfolder (Scripts, Transcripts,
 * Assets, Workbooks, Photos) as a FolderSyncAdapter. The watcher resolves which
 * project/folder a Drive change belongs to, then delegates the actual create
 * (pull) and delete (soft-delete) work to the owning adapter. This keeps the
 * two-way sync contract in one place so every folder type behaves consistently.
 */

import type { Server as SocketIOServer } from 'socket.io';
import type { DriveAsset, DriveEntityType } from '@/lib/store/drive-sync-db';

export type FolderType = 'scripts' | 'transcripts' | 'assets' | 'workbooks' | 'photos';

/**
 * Whether the local side stores the file bytes (scripts/transcripts/photos —
 * downloaded to disk) or only indexes Drive metadata (assets — Drive is the
 * store). Determines how a delete is mirrored locally.
 */
export type SyncKind = 'local-bytes' | 'metadata-only';

export interface FolderContext {
  projectId:   string;
  projectName: string;
  folderType:  FolderType;
}

/** A Drive file that has appeared (new) in a synced folder. */
export interface DrivePulledFile {
  fileId:      string;
  name:        string;
  mimeType:    string;
  webViewLink: string | null;
  fileSize:    number | null;
  modifiedAt:  string | null;
  parentId:    string;
}

/** Runtime handles the engine needs (socket emitter, target Drive). */
export interface SyncEngineContext {
  io:      SocketIOServer;
  driveId: string;
}

export interface FolderSyncAdapter {
  /** The Drive subfolder this adapter owns. */
  readonly folderType: FolderType;
  /** The drive_assets entity_type used for this folder's items. */
  readonly entityType: DriveEntityType;
  /** local-bytes (download to disk) vs metadata-only (index Drive). */
  readonly kind: SyncKind;

  /**
   * A new file appeared in this folder in Drive — bring it into LPOS.
   * local-bytes adapters download + register; metadata-only adapters index.
   */
  onDrivePull(file: DrivePulledFile, ctx: FolderContext, engine: SyncEngineContext): Promise<void>;

  /**
   * A file/folder LPOS previously synced was trashed/removed in Drive.
   * Soft-delete the local counterpart (recoverable). `asset` is the existing
   * drive_assets row for the deleted Drive file.
   */
  onDriveDelete(asset: DriveAsset, engine: SyncEngineContext): Promise<void>;
}
