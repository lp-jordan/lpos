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
import { getDriveAssetsByProject } from '@/lib/store/drive-sync-db';

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const all    = getDriveAssetsByProject(projectId);
  const assets = all.filter((a) => a.entityType === 'asset');

  return NextResponse.json({ assets });
}
