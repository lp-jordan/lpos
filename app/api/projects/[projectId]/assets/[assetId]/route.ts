/**
 * PATCH /api/projects/[projectId]/assets/[assetId]  — rename
 * DELETE /api/projects/[projectId]/assets/[assetId] — trash in Drive + drop from LPOS index
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import {
  getDriveAssetsByProject,
  getDriveAssetsByParent,
  renameDriveAsset,
  deleteDriveAssetByEntityId,
  type DriveAsset,
} from '@/lib/store/drive-sync-db';
import { getDriveClient, trashFile } from '@/lib/services/drive-client';
import { getCanonicalMediaAsset } from '@/lib/store/canonical-asset-store';
import { renameFrameioFile } from '@/lib/services/frameio';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

// ── PATCH — rename ────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId, assetId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  let body: { name?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const newName = body.name?.trim();
  if (!newName) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  // Find asset record
  const all   = getDriveAssetsByProject(projectId);
  const asset = all.find((a) => a.entityId === assetId && a.entityType === 'asset');
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  try {
    // Rename in Drive
    const drive = getDriveClient();
    await drive.files.update({
      fileId:       asset.driveFileId,
      supportsAllDrives: true,
      requestBody:  { name: newName },
      fields:       'id, name',
    });

    // Rename in Frame.io (best-effort)
    let frameioWarning: string | undefined;
    const canonical = getCanonicalMediaAsset(projectId, assetId);
    const fioFileId = canonical?.frameio?.assetId ?? null;
    if (fioFileId) {
      try {
        await renameFrameioFile(fioFileId, newName);
      } catch (fioErr) {
        console.error('[assets/rename] Frame.io rename failed:', fioErr);
        frameioWarning = 'Renamed in Drive but Frame.io rename failed: ' + (fioErr as Error).message;
      }
    }

    // Update local index
    const updated = renameDriveAsset(assetId, newName);
    return NextResponse.json({ asset: updated, ...(frameioWarning ? { warning: frameioWarning } : {}) });
  } catch (err) {
    console.error('[assets/rename] error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ── DELETE — trash in Drive + drop from LPOS index ───────────────────────────

/**
 * Recursively remove an asset's index rows. For a folder, Drive trashes the
 * whole subtree, so the descendant rows must be purged too — otherwise they
 * linger as orphans until the next scan.
 */
function purgeIndexSubtree(asset: DriveAsset): void {
  if (asset.isFolder) {
    for (const child of getDriveAssetsByParent(asset.driveFileId)) {
      purgeIndexSubtree(child);
    }
  }
  deleteDriveAssetByEntityId(asset.entityId);
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId, assetId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const all   = getDriveAssetsByProject(projectId);
  const asset = all.find((a) => a.entityId === assetId && a.entityType === 'asset');
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  // Drive is the source of truth for assets, so the delete must reach Drive —
  // otherwise the next scan re-indexes the file and the deletion silently reverts.
  // Trash (not permanent delete) keeps it recoverable from Drive Trash (~30 days).
  try {
    await trashFile(asset.driveFileId);
  } catch (err) {
    console.error('[assets/delete] Drive trash failed:', err);
    return NextResponse.json(
      { error: 'Could not remove the file from Google Drive: ' + (err as Error).message },
      { status: 502 },
    );
  }

  // Drive trash succeeded — now it's safe to drop the index row(s).
  purgeIndexSubtree(asset);
  return NextResponse.json({ ok: true });
}
