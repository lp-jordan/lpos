/**
 * GET /api/projects/[projectId]/assets
 *
 * Returns all Drive asset records (files + folders) for a project,
 * flat array ordered folders-first then by name. The client builds
 * the folder tree using parentDriveId.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getCoreDb } from '@/lib/store/core-db';
import { getDriveAssetsByProject, getDriveAssetsByProjects } from '@/lib/store/drive-sync-db';

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  // Link-group metadata
  const db  = getCoreDb();
  const row = db
    .prepare(`SELECT asset_link_group_id FROM projects WHERE project_id = ?`)
    .get(projectId) as { asset_link_group_id: string | null } | undefined;

  const groupId = row?.asset_link_group_id ?? null;

  if (!groupId) {
    const all    = getDriveAssetsByProject(projectId);
    const assets = all.filter((a) => a.entityType === 'asset');
    return NextResponse.json({ assets });
  }

  // For grouped projects, return assets belonging to ALL projects in the group
  const allGroupProjects = db
    .prepare(`SELECT project_id, name FROM projects WHERE asset_link_group_id = ?`)
    .all(groupId) as { project_id: string; name: string }[];

  const allGroupProjectIds  = allGroupProjects.map(r => r.project_id);
  const linkedProjects      = allGroupProjects
    .filter(r => r.project_id !== projectId)
    .map(r => ({ projectId: r.project_id, name: r.name }));

  const all    = getDriveAssetsByProjects(allGroupProjectIds);
  const assets = all.filter((a) => a.entityType === 'asset');

  const group = db
    .prepare(`SELECT shared_folder_name FROM asset_link_groups WHERE group_id = ?`)
    .get(groupId) as { shared_folder_name: string } | undefined;

  return NextResponse.json({
    assets,
    assetLinkGroupId:  groupId,
    sharedFolderName:  group?.shared_folder_name,
    linkedProjects,
  });
}
