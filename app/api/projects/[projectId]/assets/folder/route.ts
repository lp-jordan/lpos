/**
 * POST /api/projects/[projectId]/assets/folder
 *
 * Creates a new folder in the project's Drive assets folder.
 * Body: { name: string, parentDriveId?: string }
 * If parentDriveId is provided, creates inside that subfolder;
 * otherwise creates at the assets root.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore, getDriveWatcherService } from '@/lib/services/container';
import { createFolder } from '@/lib/services/drive-client';
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
      { error: 'Assets folder not found — Drive may still be initialising. Try again in a moment.' },
      { status: 503 },
    );
  }

  let body: { name?: string; parentDriveId?: string };
  try {
    body = await req.json() as { name?: string; parentDriveId?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const name = (body.name ?? '').trim();
  if (!name) {
    return NextResponse.json({ error: 'Folder name is required' }, { status: 400 });
  }

  const parentId = body.parentDriveId ?? assetsFolderId;

  try {
    const folderId = await createFolder(name, parentId);

    try {
      const watcher = getDriveWatcherService();
      if (watcher) await watcher.scanProjectAssets(projectId);
    } catch {
      // Non-fatal
    }

    return NextResponse.json({ ok: true, folderId });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
