/**
 * GET /api/merge-jobs/[jobId]
 *
 * Polling endpoint for merge job status. Returns current state plus
 * conflict data when the job is awaiting user resolution.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getCoreDb } from '@/lib/store/core-db';
import type { ConflictFile } from '@/lib/services/merge-worker';

type Ctx = { params: Promise<{ jobId: string }> };

interface MergeJobRow {
  job_id:             string;
  group_id:           string;
  source_project_id:  string;
  status:             string;
  conflict_payload:   string | null;
  error_message:      string | null;
  created_at:         string;
  updated_at:         string;
  completed_at:       string | null;
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { jobId } = await params;
  const row = getCoreDb()
    .prepare(`SELECT * FROM asset_merge_jobs WHERE job_id = ?`)
    .get(jobId) as MergeJobRow | undefined;

  if (!row) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const response: Record<string, unknown> = {
    jobId:           row.job_id,
    groupId:         row.group_id,
    sourceProjectId: row.source_project_id,
    status:          row.status,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
    completedAt:     row.completed_at ?? undefined,
    errorMessage:    row.error_message ?? undefined,
  };

  if (row.status === 'awaiting_resolution' && row.conflict_payload) {
    response.conflicts = JSON.parse(row.conflict_payload) as ConflictFile[];
  }

  return NextResponse.json(response);
}
