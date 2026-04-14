/**
 * DriveWatcherService
 *
 * Background service that:
 *  1. Ensures the LPOS folder tree exists in the Shared Team Drive on startup.
 *  2. Registers (and auto-renews) a Drive push notification channel so LPOS
 *     receives webhook nudges whenever files change under the /LPOS/ root.
 *  3. Processes incoming change notifications by fetching the delta via
 *     changes.list and syncing new/updated files into LPOS.
 *
 * Scripts:  downloaded locally, text-extracted, registered in scripts-registry.
 * Assets:   metadata only — not cached locally. Drive is the file store.
 * Folders:  tracked in drive_assets (is_folder=true) to enable deep file routing.
 *
 * Renewal: Drive channels expire (max ~1 week). A timer checks every 30 min
 * and re-registers the channel when it's within 1 hour of expiry.
 */

import { randomUUID } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import type { Server as SocketIOServer } from 'socket.io';

import {
  watchDrive,
  stopWatch,
  getChanges,
  getStartPageToken,
  getFileMetadata,
  downloadFile,
  listChildren,
} from './drive-client';
import {
  ensureLposRootFolder,
  getCachedProjectFolders,
  getCachedRootFolderId,
  getClientFolderIdMap,
} from './drive-folder-service';
import {
  upsertChannel,
  getActiveChannel,
  updateChannelPageToken,
  deleteChannel,
  upsertDriveAsset,
  getDriveAssetByFileId,
  getDriveFolderByDriveId,
  getDriveAssetsByProject,
  deleteDriveAssetByEntityId,
  upsertOrphanedFolder,
  getOrphanedFolderByDriveId,
} from '@/lib/store/drive-sync-db';
import {
  registerScript,
  patchScript,
  scriptsDir,
} from '@/lib/store/scripts-registry';
import { extractAndSave } from './script-extractor';
import { pushAllExistingTranscripts } from './drive-transcript-sync';
import { getProjectStore } from '@/lib/services/container';

const RENEWAL_CHECK_INTERVAL_MS = 20 * 60 * 1000; // 20 min
const RENEWAL_THRESHOLD_MS      = 25 * 60 * 1000; // renew if < 25 min left
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// ── Types ─────────────────────────────────────────────────────────────────────

type FolderType = 'scripts' | 'transcripts' | 'assets' | 'workbooks';

interface FolderContext {
  projectId:   string;
  projectName: string;
  folderType:  FolderType;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class DriveWatcherService {
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private driveId:      string;
  private webhookUrl:   string;
  private webhookToken: string;

  constructor(private io: SocketIOServer) {
    const driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim();
    if (!driveId) throw new Error('[drive-watcher] GOOGLE_DRIVE_SHARED_DRIVE_ID is not set');

    const webhookUrl = process.env.GOOGLE_DRIVE_WEBHOOK_URL?.trim();
    if (!webhookUrl) throw new Error('[drive-watcher] GOOGLE_DRIVE_WEBHOOK_URL is not set');

    const webhookToken = process.env.GOOGLE_DRIVE_WEBHOOK_TOKEN?.trim();
    if (!webhookToken) throw new Error('[drive-watcher] GOOGLE_DRIVE_WEBHOOK_TOKEN is not set');

    this.driveId      = driveId;
    this.webhookUrl   = webhookUrl;
    this.webhookToken = webhookToken;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    try {
      await ensureLposRootFolder(this.driveId);
      await this.ensureWatchChannel();

      this.renewalTimer = setInterval(
        () => void this.checkRenewal(),
        RENEWAL_CHECK_INTERVAL_MS,
      );


      // Background reconciliation — catches files missed during downtime
      void this.scanAllProjectAssets().then((n) =>
        console.log(`[drive-watcher] startup scan: ${n} assets indexed`),
      );
      void pushAllExistingTranscripts().then((n) =>
        console.log(`[drive-watcher] startup scan: ${n} transcripts pushed`),
      );

      console.log('[drive-watcher] service running');
    } catch (err) {
      console.error('[drive-watcher] failed to start:', err);
    }
  }

  /** Force-replace the watch channel regardless of expiry. Used when the
   *  webhook URL changes (e.g. Funnel toggled on/off). */
  async forceRenewChannel(): Promise<void> {
    const existing = getActiveChannel(this.driveId);
    if (existing) {
      try { await stopWatch(existing.channelId, existing.resourceId); } catch { /* may already be gone */ }
      deleteChannel(existing.channelId);
    }
    await this.registerNewChannel();
  }

  stop(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }

    console.log('[drive-watcher] stopped');
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async processIncomingChanges(): Promise<void> {
    const channel = getActiveChannel(this.driveId);
    if (!channel?.pageToken) {
      console.warn('[drive-watcher] no active channel or page token');
      return;
    }

    try {
      const { changes, newPageToken } = await getChanges(channel.pageToken, this.driveId);
      updateChannelPageToken(channel.channelId, newPageToken);

      for (const change of changes) {
        if (change.removed || change.file?.trashed) continue;
        if (!change.fileId || !change.file) continue;

        if (change.file.mimeType === FOLDER_MIME) {
          await this.processFolder(change.fileId, change.file.name ?? '');
        } else {
          await this.processFile(
            change.fileId,
            change.file.name ?? '',
            change.file.mimeType ?? '',
            change.file.size ? Number(change.file.size) : null,
            change.file.modifiedTime ?? null,
            change.file.webViewLink ?? null,
            change.file.parents ?? [],
          );
        }
      }
    } catch (err) {
      console.error('[drive-watcher] error processing changes:', err);
    }
  }

  // ── Asset scan ──────────────────────────────────────────────────────────────

  /**
   * Walks every known project's Assets folder in Drive and processes any files
   * or subfolders not yet in the drive_assets DB. Used to index files that
   * existed before the watch channel was registered.
   * Returns the total number of items processed.
   */
  /** Scan a single project's Assets folder — indexes additions and removes deletions. */
  async scanProjectAssets(projectId: string): Promise<void> {
    const project = getProjectStore().getAll().find(p => p.projectId === projectId);
    if (!project) return;
    const folders = getCachedProjectFolders(project.name, project.clientName);
    if (!folders?.assets) return;

    try {
      // Pass 1 — collect every Drive ID currently in the assets tree
      const liveIds = new Set<string>();
      await this.collectIds(folders.assets, liveIds);

      // Pass 2 — process additions/updates (existing logic handles recursion + DB upserts)
      const children = await listChildren(folders.assets, this.driveId);
      for (const child of children) {
        if (!child.id || !child.name) continue;
        if (child.mimeType === FOLDER_MIME) {
          await this.processFolder(child.id, child.name);
        } else {
          await this.processFile(
            child.id, child.name, child.mimeType ?? '',
            child.size ? Number(child.size) : null,
            child.modifiedTime ?? null,
            child.webViewLink ?? null,
            [folders.assets],
          );
        }
      }

      // Pass 3 — prune DB entries no longer present in Drive
      const dbEntries = getDriveAssetsByProject(projectId).filter(a => a.entityType === 'asset');
      let removed = 0;
      for (const entry of dbEntries) {
        if (!liveIds.has(entry.driveFileId)) {
          deleteDriveAssetByEntityId(entry.entityId);
          removed++;
        }
      }
      if (removed > 0) {
        console.log(`[drive-watcher] pruned ${removed} deleted assets for "${project.name}"`);
        this.io.emit('drive:file-synced', { entityType: 'asset', projectId, name: '' });
      }
    } catch (err) {
      console.warn(`[drive-watcher] sync failed for "${project.name}":`, err);
    }
  }

  /** Recursively collect all Drive file IDs inside a folder (files + subfolders). */
  private async collectIds(folderId: string, ids: Set<string>): Promise<void> {
    const children = await listChildren(folderId, this.driveId);
    for (const child of children) {
      if (!child.id) continue;
      ids.add(child.id);
      if (child.mimeType === FOLDER_MIME) {
        await this.collectIds(child.id, ids);
      }
    }
  }

  async scanAllProjectAssets(): Promise<number> {
    const projects = getProjectStore().getAll();
    let total = 0;

    for (const project of projects) {
      const folders = getCachedProjectFolders(project.name, project.clientName);
      if (!folders?.assets) continue;

      try {
        const children = await listChildren(folders.assets, this.driveId);
        for (const child of children) {
          if (!child.id || !child.name) continue;
          if (child.mimeType === FOLDER_MIME) {
            await this.processFolder(child.id, child.name);
          } else {
            await this.processFile(
              child.id,
              child.name,
              child.mimeType ?? '',
              child.size ? Number(child.size) : null,
              child.modifiedTime ?? null,
              child.webViewLink ?? null,
              [folders.assets],
            );
          }
          total++;
        }
      } catch (err) {
        console.warn(`[drive-watcher] scan failed for "${project.name}":`, err);
      }
    }

    console.log(`[drive-watcher] scan complete — ${total} items processed`);
    return total;
  }

  // ── Channel management ──────────────────────────────────────────────────────

  async ensureWatchChannel(): Promise<void> {
    const existing = getActiveChannel(this.driveId);
    const now = Date.now();

    if (existing) {
      const expiresAt = new Date(existing.expiresAt).getTime();
      if (expiresAt - now > RENEWAL_THRESHOLD_MS) {
        console.log(`[drive-watcher] channel valid until ${existing.expiresAt}`);
        return;
      }
      try { await stopWatch(existing.channelId, existing.resourceId); } catch { /* expired */ }
      deleteChannel(existing.channelId);
    }

    await this.registerNewChannel();
  }

  private async registerNewChannel(): Promise<void> {
    const channelId = randomUUID();
    const pageToken = await getStartPageToken(this.driveId);
    const channel   = await watchDrive(this.driveId, this.webhookUrl, this.webhookToken, channelId);

    upsertChannel({
      channelId:  channel.channelId,
      resourceId: channel.resourceId,
      driveId:    this.driveId,
      pageToken,
      expiresAt:  new Date(channel.expiration).toISOString(),
    });

    console.log(`[drive-watcher] channel registered, expires ${new Date(channel.expiration).toISOString()}`);
  }

  private async checkRenewal(): Promise<void> {
    const channel = getActiveChannel(this.driveId);
    if (!channel) { await this.registerNewChannel(); return; }

    if (Date.now() + RENEWAL_THRESHOLD_MS >= new Date(channel.expiresAt).getTime()) {
      console.log('[drive-watcher] channel expiring soon — renewing');
      try { await stopWatch(channel.channelId, channel.resourceId); } catch { /* expired */ }
      deleteChannel(channel.channelId);
      await this.registerNewChannel();
    }
  }

  // ── Folder processing ───────────────────────────────────────────────────────

  /**
   * Process a Drive folder entity. If it belongs to an LPOS Assets tree,
   * register it in drive_assets and recursively process its children.
   *
   * If the folder is already known we still recurse — this ensures files
   * added to the folder after it was first seen are picked up on re-scan.
   */
  private async processFolder(folderId: string, folderName: string): Promise<void> {
    const alreadyKnown = !!getDriveFolderByDriveId(folderId);

    if (!alreadyKnown) {
      // New folder — fetch metadata to verify it belongs to an Assets tree
      let metadata;
      try { metadata = await getFileMetadata(folderId); } catch { return; }
      if (metadata.trashed) return;

      const parentId = metadata.parents?.[0];
      if (!parentId) return;

      const ctx = this.resolveContext(parentId);
      if (!ctx) {
        await this.handleOrphanedFolder(folderId, folderName, metadata);
        return;
      }
      if (ctx.folderType !== 'assets') return; // only track Assets tree

      upsertDriveAsset({
        entityType:    'asset',
        entityId:      randomUUID(),
        projectId:     ctx.projectId,
        driveFileId:   folderId,
        name:          folderName || metadata.name || 'Untitled Folder',
        mimeType:      FOLDER_MIME,
        webViewLink:   metadata.webViewLink ?? undefined,
        isFolder:      true,
        parentDriveId: parentId,
      });

      console.log(`[drive-watcher] registered folder: ${folderName}`);
    }

    // Always recurse — picks up files added after the folder was first registered
    try {
      const children = await listChildren(folderId, this.driveId);
      for (const child of children) {
        if (!child.id || !child.name) continue;
        if (child.mimeType === FOLDER_MIME) {
          await this.processFolder(child.id, child.name);
        } else {
          await this.processFile(
            child.id, child.name, child.mimeType ?? '',
            child.size ? Number(child.size) : null,
            child.modifiedTime ?? null,
            child.webViewLink ?? null,
            [folderId],
          );
        }
      }
    } catch (err) {
      console.warn(`[drive-watcher] error listing children of ${folderId}:`, err);
    }
  }

  // ── File processing ─────────────────────────────────────────────────────────

  private async processFile(
    fileId:      string,
    fileName:    string,
    mimeType:    string,
    fileSize:    number | null,
    modifiedAt:  string | null,
    webViewLink: string | null,
    parents:     string[],
  ): Promise<void> {
    const parentId = parents[0];
    if (!parentId) return;

    const ctx = this.resolveContext(parentId);
    if (!ctx) return;

    const existing = getDriveAssetByFileId(fileId);
    if (existing) {
      // Update metadata in case name or modifiedAt changed
      upsertDriveAsset({
        entityType:    existing.entityType,
        entityId:      existing.entityId,
        projectId:     existing.projectId,
        driveFileId:   fileId,
        name:          fileName || existing.name,
        mimeType,
        webViewLink:   webViewLink ?? undefined,
        isFolder:      false,
        parentDriveId: parentId,
        fileSize:      fileSize ?? undefined,
        modifiedAt:    modifiedAt ?? undefined,
      });
      return;
    }

    // New file — route by folder type
    if (ctx.folderType === 'scripts') {
      await this.pullScriptFromDrive(fileId, fileName, mimeType, webViewLink ?? '', fileSize, modifiedAt, parentId, ctx);
    } else if (ctx.folderType === 'assets') {
      await this.pullAssetFromDrive(fileId, fileName, mimeType, webViewLink ?? '', fileSize, modifiedAt, parentId, ctx);
    }
    // transcripts + workbooks: future phases
  }

  // ── Script pull ─────────────────────────────────────────────────────────────

  private async pullScriptFromDrive(
    fileId:      string,
    fileName:    string,
    mimeType:    string,
    webViewLink: string,
    fileSize:    number | null,
    modifiedAt:  string | null,
    parentId:    string,
    ctx:         FolderContext,
  ): Promise<void> {
    const ext = path.extname(fileName).toLowerCase();
    const allowed = new Set(['.docx', '.pdf', '.txt', '.doc']);
    if (!allowed.has(ext)) return;

    try {
      const buffer = await downloadFile(fileId);
      const dir    = scriptsDir(ctx.projectId);
      fs.mkdirSync(dir, { recursive: true });

      const script = registerScript({
        projectId:        ctx.projectId,
        name:             path.basename(fileName, ext),
        originalFilename: fileName,
        filePath:         '',
        fileSize:         buffer.length,
        mimeType,
      });

      const finalPath = path.join(dir, `${script.scriptId}${ext}`);
      fs.writeFileSync(finalPath, buffer);

      patchScript(ctx.projectId, script.scriptId, {
        filePath:        finalPath,
        driveFileId:     fileId,
        driveWebViewUrl: webViewLink,
        driveSource:     true,
      });

      upsertDriveAsset({
        entityType:    'script',
        entityId:      script.scriptId,
        projectId:     ctx.projectId,
        driveFileId:   fileId,
        driveFolderId: parentId,
        name:          fileName,
        mimeType,
        webViewLink,
        isFolder:      false,
        parentDriveId: parentId,
        localPath:     finalPath,
        fileSize:      fileSize ?? undefined,
        modifiedAt:    modifiedAt ?? undefined,
      });

      void extractAndSave(ctx.projectId, script.scriptId, finalPath, ext);

      this.io.emit('drive:file-synced', {
        entityType: 'script',
        entityId:   script.scriptId,
        projectId:  ctx.projectId,
        name:       fileName,
      });

      console.log(`[drive-watcher] pulled script: ${fileName} → ${ctx.projectName}`);
    } catch (err) {
      console.error(`[drive-watcher] failed to pull script ${fileId}:`, err);
    }
  }

  // ── Asset pull (metadata only — no local cache) ─────────────────────────────

  private async pullAssetFromDrive(
    fileId:      string,
    fileName:    string,
    mimeType:    string,
    webViewLink: string,
    fileSize:    number | null,
    modifiedAt:  string | null,
    parentId:    string,
    ctx:         FolderContext,
  ): Promise<void> {
    try {
      const entityId = randomUUID();

      upsertDriveAsset({
        entityType:    'asset',
        entityId,
        projectId:     ctx.projectId,
        driveFileId:   fileId,
        driveFolderId: parentId,
        name:          fileName,
        mimeType,
        webViewLink,
        isFolder:      false,
        parentDriveId: parentId,
        fileSize:      fileSize ?? undefined,
        modifiedAt:    modifiedAt ?? undefined,
      });

      this.io.emit('drive:file-synced', {
        entityType: 'asset',
        entityId,
        projectId:  ctx.projectId,
        name:       fileName,
      });

      console.log(`[drive-watcher] indexed asset: ${fileName} → ${ctx.projectName}`);
    } catch (err) {
      console.error(`[drive-watcher] failed to index asset ${fileId}:`, err);
    }
  }

  // ── Orphaned folder handling ────────────────────────────────────────────────

  /**
   * Called when a new folder can't be resolved to any LPOS project. If the
   * folder's parent is a known client folder it's a project-level orphan —
   * queue it and notify all connected clients so admins can act on it.
   */
  private async handleOrphanedFolder(
    folderId:   string,
    folderName: string,
    metadata:   { parents?: string[] | null },
  ): Promise<void> {
    const parentId = metadata.parents?.[0];
    if (!parentId) return;

    const clientFolderMap = getClientFolderIdMap(); // folderId → clientName
    const clientName = clientFolderMap[parentId];
    if (!clientName) return; // parent isn't a known client folder — ignore

    if (getOrphanedFolderByDriveId(folderId)) return; // already queued

    upsertOrphanedFolder({ driveFileId: folderId, name: folderName, clientName, parentDriveId: parentId });

    console.log(`[drive-watcher] orphaned project folder queued: "${clientName} / ${folderName}"`);

    this.io.emit('drive:orphaned-folder', {
      folderName,
      clientName,
      driveFileId: folderId,
      detectedAt:  new Date().toISOString(),
    });
  }

  // ── Context resolution ──────────────────────────────────────────────────────

  /**
   * Given a Drive folder ID, resolve which LPOS project and folder type it
   * belongs to. Checks the cached project folder map first (fast path), then
   * falls back to the drive_assets table for deeply nested subfolders.
   */
  private resolveContext(folderId: string): FolderContext | null {
    // Fast path: check fixed project folder cache
    const projects = getProjectStore().getAll();
    for (const project of projects) {
      const cached = getCachedProjectFolders(project.name, project.clientName);
      if (!cached) continue;

      const typeMap: Record<string, FolderType> = {
        [cached.scripts]:     'scripts',
        [cached.transcripts]: 'transcripts',
        [cached.assets]:      'assets',
        [cached.workbooks]:   'workbooks',
      };

      const folderType = typeMap[folderId];
      if (folderType) {
        return { projectId: project.projectId, projectName: project.name, folderType };
      }
    }

    // Deep path: look up subfolder in drive_assets DB to inherit parent context
    const knownFolder = getDriveFolderByDriveId(folderId);
    if (knownFolder) {
      return {
        projectId:   knownFolder.projectId,
        projectName: projects.find(p => p.projectId === knownFolder.projectId)?.name ?? '',
        folderType:  knownFolder.entityType === 'asset' ? 'assets' : knownFolder.entityType as FolderType,
      };
    }

    return null;
  }

  // ── Status ───────────────────────────────────────────────────────────────────

  getStatus(): { active: boolean; channelExpiresAt: string | null } {
    const channel = getActiveChannel(this.driveId);
    return {
      active:           !!channel,
      channelExpiresAt: channel?.expiresAt ?? null,
    };
  }
}
