/**
 * POST /api/projects/link-assets
 *
 * Creates a shared asset link group from 2+ projects under the same client.
 * Creates the shared Drive folder, creates merge jobs for all projects,
 * locks them, and kicks off merge workers fire-and-forget.
 *
 * Body: { projectIds: string[] }  — minimum 2, all must share the same clientName
 * Response 202: { groupId, jobIds, status: 'pending' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getCoreDb } from '@/lib/store/core-db';
import {
  createSharedAssetsFolder,
  ensureLposRootFolder,
  getCachedRootFolderId,
  getProjectLock,
  lockProject,
} from '@/lib/services/drive-folder-service';
import { runMergeJob } from '@/lib/services/merge-worker';

export async function POST(req: NextRequest) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const body = await req.json() as { projectIds?: unknown };
  const { projectIds } = body;

  if (!Array.isArray(projectIds) || projectIds.length < 2) {
    return NextResponse.json({ error: 'projectIds must be an array of at least 2 IDs' }, { status: 400 });
  }

  const store    = getProjectStore();
  const projects = projectIds.map((id: unknown) => {
    if (typeof id !== 'string') return null;
    return store.getById(id);
  });

  if (projects.some(p => !p)) {
    return NextResponse.json({ error: 'One or more project IDs not found' }, { status: 404 });
  }

  const valid = projects as NonNullable<(typeof projects)[number]>[];

  // All must share the same client
  const clientName = valid[0].clientName;
  if (!valid.every(p => p.clientName === clientName)) {
    return NextResponse.json({ error: 'All projects must belong to the same client' }, { status: 422 });
  }

  // None can already be in a group
  const db = getCoreDb();
  for (const p of valid) {
    const row = db.prepare(`SELECT asset_link_group_id FROM projects WHERE project_id = ?`).get(p.projectId) as
      { asset_link_group_id: string | null } | undefined;
    if (row?.asset_link_group_id) {
      return NextResponse.json(
        { error: `Project "${p.name}" is already in a link group` },
        { status: 409 },
      );
    }
    if (getProjectLock(p.projectId)) {
      return NextResponse.json(
        { error: `Project "${p.name}" is currently locked` },
        { status: 409 },
      );
    }
  }

  const driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim();
  if (!driveId) {
    return NextResponse.json({ error: 'Drive is not configured on this server' }, { status: 503 });
  }

  // Ensure root folder exists (needed if this is the very first Drive operation)
  const rootId = getCachedRootFolderId() ?? await ensureLposRootFolder(driveId);
  void rootId;

  // Create the link group record
  const groupId          = crypto.randomUUID();
  const sharedFolderName = `${clientName} (Shared)`;

  db.prepare(`
    INSERT INTO asset_link_groups (group_id, client_name, shared_folder_name, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(groupId, clientName, sharedFolderName);

  // Create shared Drive folder at client level
  try {
    await createSharedAssetsFolder(clientName, groupId, driveId);
  } catch (err) {
    db.prepare(`DELETE FROM asset_link_groups WHERE group_id = ?`).run(groupId);
    console.error('[link-assets] Failed to create shared Drive folder:', err);
    return NextResponse.json({ error: 'Failed to create shared Drive folder' }, { status: 502 });
  }

  // Create merge jobs for all projects, lock them, then kick off the first job only.
  // The merge worker chains each job to the next when it completes — running them
  // serially avoids concurrent writes to the same shared folder.
  const jobIds: string[] = [];
  for (const p of valid) {
    const jobId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO asset_merge_jobs (job_id, group_id, source_project_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))
    `).run(jobId, groupId, p.projectId);

    lockProject(p.projectId, 'merging', jobId);
    jobIds.push(jobId);
  }

  // Broadcast updated project list (all now show assetMergeLocked = true)
  getProjectStore().broadcastAll();

  // Fire only the first job — the worker will chain to subsequent pending jobs
  runMergeJob(jobIds[0]).catch(err =>
    console.error(`[link-assets] Merge job ${jobIds[0]} failed:`, err),
  );

  return NextResponse.json({ groupId, jobIds, status: 'pending' }, { status: 202 });
}
