/**
 * POST /api/admin/merge-jobs/[jobId]/recover
 *
 * Recovery endpoint for stuck merge jobs (status = 'failed', lock still held).
 *
 * Body: { action: 'retry' | 'release' }
 *
 *   retry   — resets the job to 'pending' and re-fires runMergeJob.
 *             Use when the root cause (Drive outage, transient error) is resolved.
 *
 *   release — leaves the job in 'failed' state for audit but removes the
 *             project lock so Assets tab becomes accessible again.
 *             Use when the merge cannot complete and manual cleanup is needed.
 *
 * Returns 202 for retry (async), 200 for release.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getCoreDb } from '@/lib/store/core-db';
import { unlockProject } from '@/lib/services/drive-folder-service';
import { runMergeJob } from '@/lib/services/merge-worker';

interface MergeJobRow {
  job_id:            string;
  source_project_id: string;
  status:            string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { jobId } = await params;
  const body = await req.json() as { action?: unknown };
  const { action } = body;

  if (action !== 'retry' && action !== 'release') {
    return NextResponse.json({ error: 'action must be "retry" or "release"' }, { status: 400 });
  }

  const db  = getCoreDb();
  const row = db.prepare(`SELECT job_id, source_project_id, status FROM asset_merge_jobs WHERE job_id = ?`)
    .get(jobId) as MergeJobRow | undefined;

  if (!row) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  if (action === 'release') {
    unlockProject(row.source_project_id);
    console.log(`[admin-recover] Released lock for project ${row.source_project_id} (job ${jobId})`);
    return NextResponse.json({ ok: true, message: 'Lock released — job left in failed state for audit' });
  }

  // retry: reset to pending and re-run
  db.prepare(`
    UPDATE asset_merge_jobs
    SET status = 'pending', error_message = NULL, updated_at = datetime('now')
    WHERE job_id = ?
  `).run(jobId);

  runMergeJob(jobId).catch((err: unknown) =>
    console.error(`[admin-recover] Re-run of job ${jobId} failed:`, err),
  );

  console.log(`[admin-recover] Job ${jobId} queued for retry`);
  return NextResponse.json({ ok: true, message: 'Job queued for retry' }, { status: 202 });
}
