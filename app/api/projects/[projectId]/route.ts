import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import { resolveRequestActor } from '@/lib/services/activity-actor';
import {
  cleanupGroupIfEmpty,
  detachProjectFromGroup,
  renameProjectFolder,
  unlockProject,
} from '@/lib/services/drive-folder-service';
import { getCoreDb } from '@/lib/store/core-db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const project = getProjectStore().getById(projectId);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ project });
  } catch {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const body = await req.json() as { name?: string; clientName?: string; archived?: boolean; cloudflareDefaults?: { thumbnailFrameNumber: number } };

    // Capture old values before update for Drive rename
    const existing = getProjectStore().getById(projectId);

    const project = getProjectStore().update(projectId, body, {
      actor: resolveRequestActor(req),
      source_kind: 'api',
    });
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Fire-and-forget Drive folder rename if project name changed
    const driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim();
    if (driveId && existing && body.name && body.name !== existing.name) {
      void renameProjectFolder(driveId, existing.clientName, existing.name, body.name);
    }

    return NextResponse.json({ project });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const store   = getProjectStore();
    const project = store.getById(projectId);

    if (project?.assetLinkGroupId) {
      const db = getCoreDb();
      // Fail any in-flight merge jobs so they don't resume against a deleted project
      db.prepare(`
        UPDATE asset_merge_jobs
        SET status = 'failed', error_message = 'Project deleted', updated_at = datetime('now')
        WHERE source_project_id = ? AND status NOT IN ('completed', 'failed')
      `).run(projectId);

      // Release lock (safe no-op if none exists)
      unlockProject(projectId);

      // Detach from group in DB + cache
      detachProjectFromGroup(projectId, project.name, project.clientName);

      // If no other projects reference the group, clean up the group record
      cleanupGroupIfEmpty(project.assetLinkGroupId);
    }

    const ok = store.delete(projectId, {
      actor: resolveRequestActor(_req),
      source_kind: 'api',
    });
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
