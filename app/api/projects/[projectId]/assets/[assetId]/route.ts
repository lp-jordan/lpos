/**
 * PATCH /api/projects/[projectId]/assets/[assetId]  — rename
 * DELETE /api/projects/[projectId]/assets/[assetId] — remove from LPOS index (not Drive)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import {
  getDriveAssetsByProject,
  renameDriveAsset,
  deleteDriveAssetByEntityId,
} from '@/lib/store/drive-sync-db';
import { getDriveClient } from '@/lib/services/drive-client';

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

    // Update local index
    const updated = renameDriveAsset(assetId, newName);
    return NextResponse.json({ asset: updated });
  } catch (err) {
    console.error('[assets/rename] error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ── DELETE — remove from LPOS index ──────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId, assetId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const all   = getDriveAssetsByProject(projectId);
  const asset = all.find((a) => a.entityId === assetId && a.entityType === 'asset');
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  deleteDriveAssetByEntityId(assetId);
  return NextResponse.json({ ok: true });
}
