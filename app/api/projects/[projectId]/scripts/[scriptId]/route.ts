import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { getScript, patchScript, removeScript } from '@/lib/store/scripts-registry';

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

// ── DELETE — remove script ────────────────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, scriptId } = await params;
    const script = getScript(projectId, scriptId);
    if (!script) return NextResponse.json({ error: 'Script not found' }, { status: 404 });

    const url    = new URL(req.url);
    const delFile = url.searchParams.get('deleteFile') === 'true';

    const removed = removeScript(projectId, scriptId);

    if (delFile && removed?.filePath) {
      try { fs.unlinkSync(removed.filePath); } catch { /* already gone */ }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
