/**
 * POST /api/projects/link-assets/add
 *
 * Adds a single project to an existing link group.
 * The project must be under the same client as the group and not already linked.
 *
 * Body: { projectId: string, groupId: string }
 * Response 202: { jobId, status: 'pending' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getCoreDb } from '@/lib/store/core-db';
import { getProjectLock, lockProject } from '@/lib/services/drive-folder-service';
import { runMergeJob } from '@/lib/services/merge-worker';

export async function POST(req: NextRequest) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const body = await req.json() as { projectId?: unknown; groupId?: unknown };
  const { projectId, groupId } = body;

  if (typeof projectId !== 'string' || typeof groupId !== 'string') {
    return NextResponse.json({ error: 'projectId and groupId are required strings' }, { status: 400 });
  }

  const db    = getCoreDb();
  const store = getProjectStore();

  const project = store.getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const group = db
    .prepare(`SELECT group_id, client_name FROM asset_link_groups WHERE group_id = ?`)
    .get(groupId) as { group_id: string; client_name: string } | undefined;
  if (!group) return NextResponse.json({ error: 'Link group not found' }, { status: 404 });

  if (project.clientName !== group.client_name) {
    return NextResponse.json(
      { error: 'Project and link group must belong to the same client' },
      { status: 422 },
    );
  }

  const existing = db
    .prepare(`SELECT asset_link_group_id FROM projects WHERE project_id = ?`)
    .get(projectId) as { asset_link_group_id: string | null } | undefined;
  if (existing?.asset_link_group_id) {
    return NextResponse.json({ error: 'Project is already in a link group' }, { status: 409 });
  }
  if (getProjectLock(projectId)) {
    return NextResponse.json({ error: 'Project is currently locked' }, { status: 409 });
  }

  if (!process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim()) {
    return NextResponse.json({ error: 'Drive is not configured on this server' }, { status: 503 });
  }

  const jobId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO asset_merge_jobs (job_id, group_id, source_project_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))
  `).run(jobId, groupId, projectId);

  lockProject(projectId, 'merging', jobId);

  runMergeJob(jobId).catch(err =>
    console.error(`[link-assets/add] Merge job ${jobId} failed for "${project.name}":`, err),
  );

  return NextResponse.json({ jobId, status: 'pending' }, { status: 202 });
}
