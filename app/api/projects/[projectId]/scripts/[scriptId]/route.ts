import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { getScript, patchScript, removeScript } from '@/lib/store/scripts-registry';
import { trashFile } from '@/lib/services/drive-client';
import { softDeleteLocalFile } from '@/lib/services/drive-sync';
import {
  getDriveAssetByEntityId,
  deleteDriveAssetByEntityId,
} from '@/lib/store/drive-sync-db';

type Ctx = { params: Promise<{ projectId: string; scriptId: string }> };

// ── GET — single script ───────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, scriptId } = await params;
  const script = getScript(projectId, scriptId);
  if (!script) return NextResponse.json({ error: 'Script not found' }, { status: 404 });
  return NextResponse.json({ script });
}

// ── PATCH — update name ───────────────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, scriptId } = await params;
    const script = getScript(projectId, scriptId);
    if (!script) return NextResponse.json({ error: 'Script not found' }, { status: 404 });

    const body = await req.json() as { name?: string };
    const updated = patchScript(projectId, scriptId, {
      ...(body.name !== undefined && { name: body.name }),
    });

    return NextResponse.json({ script: updated });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ── DELETE — remove script (mirror to Drive Trash + soft-delete locally) ─────

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, scriptId } = await params;
    const script = getScript(projectId, scriptId);
    if (!script) return NextResponse.json({ error: 'Script not found' }, { status: 404 });

    const delFile = new URL(req.url).searchParams.get('deleteFile') === 'true';

    // If the local file is being deleted AND a Drive copy exists, the Drive
    // copy must be trashed FIRST. Otherwise the Drive file would zombie back
    // on the next sync (re-pull as a new script, or surface stale via search).
    // Drive trash is recoverable for ~30 days; we don't permanent-delete.
    if (delFile && script.driveFileId) {
      try {
        await trashFile(script.driveFileId);
      } catch (err) {
        console.error('[scripts/delete] Drive trash failed:', err);
        return NextResponse.json(
          { error: 'Could not remove the script from Google Drive: ' + (err as Error).message },
          { status: 502 },
        );
      }
    }

    const removed = removeScript(projectId, scriptId);

    if (delFile) {
      // Soft-delete the script bytes + extracted-text sidecar into
      // data/projects/<id>/.trash/, mirroring how Drive→LPOS deletes handle
      // local-bytes (so a mistaken delete is recoverable on both sides).
      if (removed?.filePath) {
        softDeleteLocalFile(projectId, removed.filePath);
        softDeleteLocalFile(
          projectId,
          path.join(path.dirname(removed.filePath), `${scriptId}.extracted.txt`),
        );
      }
      // Drop the drive_assets link row so the engine forgets the mapping (and
      // the echoed `trashed` webhook from Drive becomes a no-op).
      if (script.driveFileId) {
        const row = getDriveAssetByEntityId('script', scriptId);
        if (row) deleteDriveAssetByEntityId(row.entityId);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
