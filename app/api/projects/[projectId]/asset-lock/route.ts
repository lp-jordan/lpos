/**
 * GET /api/projects/[projectId]/asset-lock
 *
 * Returns whether the project's assets tab is currently locked.
 * Polled by AssetsTab while a merge or unlink operation is in progress.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getProjectLock } from '@/lib/services/drive-folder-service';
import { getCoreDb } from '@/lib/store/core-db';

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const lock = getProjectLock(projectId);
  if (!lock) return NextResponse.json({ locked: false });

  // Check whether the associated merge job has failed so the UI can show the right message
  let jobFailed = false;
  if (lock.jobId) {
    const row = getCoreDb()
      .prepare(`SELECT status FROM asset_merge_jobs WHERE job_id = ?`)
      .get(lock.jobId) as { status: string } | undefined;
    jobFailed = row?.status === 'failed';
  }

  return NextResponse.json({
    locked:    true,
    reason:    lock.reason,
    jobId:     lock.jobId ?? undefined,
    lockedAt:  lock.lockedAt,
    jobFailed,
  });
}
