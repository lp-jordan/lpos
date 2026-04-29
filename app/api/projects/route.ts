import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import { resolveRequestActor } from '@/lib/services/activity-actor';
import type { Project } from '@/lib/models/project';
import { ensureLposRootFolder, ensureProjectFolders, adoptOrphanedFolderContents } from '@/lib/services/drive-folder-service';
import { getOrphanedFolderByClientProject, markOrphanedFolderResolved } from '@/lib/store/drive-sync-db';

export async function GET() {
  try {
    const projects = getProjectStore().getAll();
    return NextResponse.json({ projects });
  } catch {
    return NextResponse.json({ projects: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { name?: string; clientName?: string };
    const { name, clientName } = body;

    if (!name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });

    const project = getProjectStore().create(
      { name, clientName: clientName ?? '' },
      { actor: resolveRequestActor(req), source_kind: 'api' },
    );

    setupProjectDriveFolders(project).catch(err =>
      console.warn('[drive] folder setup failed for new project:', err),
    );

    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

async function setupProjectDriveFolders(project: Project): Promise<void> {
  const driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim();
  if (!driveId) return;

  const rootFolderId = await ensureLposRootFolder(driveId);
  const folders = await ensureProjectFolders(driveId, rootFolderId, project.name, project.clientName);

  const orphaned = getOrphanedFolderByClientProject(project.clientName, project.name);
  if (!orphaned) return;

  if (folders.assets) {
    await adoptOrphanedFolderContents(orphaned.driveFileId, folders.assets, driveId);
  }
  markOrphanedFolderResolved(orphaned.driveFileId);
  console.log(`[drive] adopted orphaned folder for: ${project.clientName} / ${project.name}`);
}
