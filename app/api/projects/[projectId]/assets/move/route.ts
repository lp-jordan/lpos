/**
 * POST /api/projects/[projectId]/assets/move
 *
 * Moves one or more assets (files or folders) to a different folder in Drive.
 * Body: { entityIds: string[], targetDriveId: string }
 * targetDriveId must be a Drive folder ID within the project's assets tree,
 * or the assets root folder ID itself.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore, getDriveWatcherService } from '@/lib/services/container';
import { moveFile } from '@/lib/services/drive-client';
import { getDriveAssetsByProject } from '@/lib/store/drive-sync-db';
import { moveDriveAsset } from '@/lib/store/drive-sync-db';
import { resolveAssetsFolder } from '@/lib/services/drive-folder-service';

type Ctx = { params: Promise<{ projectId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const assetsFolderId = resolveAssetsFolder(project.name, project.clientName);
  if (!assetsFolderId) {
    return NextResponse.json(
      { error: 'Assets folder not found — Drive may still be initialising.' },
      { status: 503 },
    );
  }

  let body: { entityIds?: string[]; targetDriveId?: string };
  try {
    body = await req.json() as { entityIds?: string[]; targetDriveId?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { entityIds, targetDriveId } = body;
  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    return NextResponse.json({ error: 'entityIds must be a non-empty array' }, { status: 400 });
  }
  if (!targetDriveId) {
    return NextResponse.json({ error: 'targetDriveId is required' }, { status: 400 });
  }

  const all    = getDriveAssetsByProject(projectId);
  const byId   = new Map(all.map((a) => [a.entityId, a]));

  const moved:  string[] = [];
  const errors: { entityId: string; error: string }[] = [];

  for (const entityId of entityIds) {
    const asset = byId.get(entityId);
    if (!asset) { errors.push({ entityId, error: 'Asset not found' }); continue; }

    const oldParentId = asset.parentDriveId ?? assetsFolderId;
    if (oldParentId === targetDriveId) { moved.push(entityId); continue; } // already there

    try {
      await moveFile(asset.driveFileId, targetDriveId, oldParentId);
      moveDriveAsset(entityId, targetDriveId);
      moved.push(entityId);
    } catch (err) {
      errors.push({ entityId, error: (err as Error).message });
    }
  }

  try {
    const watcher = getDriveWatcherService();
    if (watcher) await watcher.scanProjectAssets(projectId);
  } catch {
    // Non-fatal
  }

  if (moved.length === 0) {
    return NextResponse.json({ error: 'All moves failed', errors }, { status: 500 });
  }

  return NextResponse.json({ ok: true, moved: moved.length, errors });
}
