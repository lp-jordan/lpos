/**
 * POST /api/admin/drive/backfill
 *
 * Creates Drive folder trees for all existing LPOS projects.
 * Idempotent — safe to re-run at any time.
 * Admin-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import {
  ensureLposRootFolder,
  ensureAllProjectFolders,
  getCachedRootFolderId,
} from '@/lib/services/drive-folder-service';

export async function POST(req: NextRequest) {
  const authError = await requireRole(req, 'admin');
  if (authError) return authError;

  const driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim();
  if (!driveId) {
    return NextResponse.json(
      { error: 'GOOGLE_DRIVE_SHARED_DRIVE_ID is not set' },
      { status: 500 },
    );
  }

  try {
    let rootFolderId = getCachedRootFolderId();
    if (!rootFolderId) rootFolderId = await ensureLposRootFolder(driveId);

    const projects = getProjectStore().getAll();
    const count    = await ensureAllProjectFolders(driveId, rootFolderId, projects);

    return NextResponse.json({ ok: true, projectCount: count });
  } catch (err) {
    console.error('[admin/drive/backfill] error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
