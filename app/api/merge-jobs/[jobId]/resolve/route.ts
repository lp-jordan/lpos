/**
 * POST /api/merge-jobs/[jobId]/resolve
 *
 * Submit conflict resolutions for a job in awaiting_resolution state.
 * Transitions the job to merging and resumes the merge worker fire-and-forget.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getCoreDb } from '@/lib/store/core-db';
import { resumeAfterResolution, type ResolutionMap } from '@/lib/services/merge-worker';

type Ctx = { params: Promise<{ jobId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { jobId } = await params;

  const row = getCoreDb()
    .prepare(`SELECT status FROM asset_merge_jobs WHERE job_id = ?`)
    .get(jobId) as { status: string } | undefined;

  if (!row) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (row.status !== 'awaiting_resolution') {
    return NextResponse.json(
      { error: `Job is not awaiting resolution (current status: ${row.status})` },
      { status: 409 },
    );
  }

  const body = await req.json() as { resolutions?: Record<string, string> };
  if (!body.resolutions || typeof body.resolutions !== 'object') {
    return NextResponse.json({ error: 'resolutions object is required' }, { status: 400 });
  }

  const validValues = new Set(['keep_source', 'keep_target', 'keep_both']);
  for (const [filename, resolution] of Object.entries(body.resolutions)) {
    if (!validValues.has(resolution)) {
      return NextResponse.json(
        { error: `Invalid resolution "${resolution}" for "${filename}"` },
        { status: 400 },
      );
    }
  }

  const resolutionMap: ResolutionMap = {
    resolutions: body.resolutions as ResolutionMap['resolutions'],
  };

  // Fire-and-forget — response returns immediately
  resumeAfterResolution(jobId, resolutionMap).catch(err =>
    console.error(`[api] resolve failed for job ${jobId}:`, err),
  );

  return NextResponse.json({ jobId, status: 'merging' }, { status: 202 });
}
