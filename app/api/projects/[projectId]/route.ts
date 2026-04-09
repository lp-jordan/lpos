import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import { resolveRequestActor } from '@/lib/services/activity-actor';
import { renameProjectFolder } from '@/lib/services/drive-folder-service';

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
    const body = await req.json() as { name?: string; clientName?: string; archived?: boolean };

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
    const ok = getProjectStore().delete(projectId, {
      actor: resolveRequestActor(_req),
      source_kind: 'api',
    });
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
