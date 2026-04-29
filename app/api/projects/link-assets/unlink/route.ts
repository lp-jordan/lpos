/**
 * POST /api/projects/link-assets/unlink
 *
 * Removes a project from its link group. Provisions a fresh per-project
 * Assets folder in Drive and releases the lock when done.
 * Synchronous — awaits the Drive folder creation before responding.
 *
 * Body: { projectId: string }
 * Response 200: { projectId, status: 'unlinked' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getCoreDb } from '@/lib/store/core-db';
import {
  detachProjectFromGroup,
  getProjectLock,
  lockProject,
  provisionFreshAssetsFolder,
  unlockProject,
} from '@/lib/services/drive-folder-service';

export async function POST(req: NextRequest) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const body = await req.json() as { projectId?: unknown };
  const { projectId } = body;

  if (typeof projectId !== 'string') {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  const db      = getCoreDb();
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const row = db
    .prepare(`SELECT asset_link_group_id FROM projects WHERE project_id = ?`)
    .get(projectId) as { asset_link_group_id: string | null } | undefined;

  if (!row?.asset_link_group_id) {
    return NextResponse.json({ error: 'Project is not in a link group' }, { status: 409 });
  }
  if (getProjectLock(projectId)) {
    return NextResponse.json({ error: 'Project is currently locked' }, { status: 409 });
  }

  const driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim();
  if (!driveId) {
    return NextResponse.json({ error: 'Drive is not configured on this server' }, { status: 503 });
  }

  lockProject(projectId, 'unlinking');
  getProjectStore().broadcastAll(); // show "unlinking" lock on project list immediately

  try {
    detachProjectFromGroup(projectId, project.name, project.clientName);
    await provisionFreshAssetsFolder(project.name, project.clientName, driveId);
    unlockProject(projectId);
    getProjectStore().broadcastAll(); // clear lock + clear assetLinkGroupId on project list
  } catch (err) {
    unlockProject(projectId);
    getProjectStore().broadcastAll();
    console.error(`[link-assets/unlink] Failed to provision folder for "${project.name}":`, err);
    return NextResponse.json({ error: 'Failed to provision new Drive folder' }, { status: 502 });
  }

  return NextResponse.json({ projectId, status: 'unlinked' });
}
