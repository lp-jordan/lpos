/**
 * /api/projects/[projectId]/scripts/[scriptId]/file
 *
 * GET — Serve the raw script file (for LeaderPrompt to download)
 * PUT — Replace the file with an updated version LP sends back,
 *        then re-extract text. No versioning — last write wins.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { Readable } from 'node:stream';
import { getScript, patchScript } from '@/lib/store/scripts-registry';
import { extractAndSave } from '@/lib/services/script-extractor';

type Ctx = { params: Promise<{ projectId: string; scriptId: string }> };

// ── GET — download the file ───────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, scriptId } = await params;
  const script = getScript(projectId, scriptId);
  if (!script) return NextResponse.json({ error: 'Script not found' }, { status: 404 });
  if (!script.filePath || !fs.existsSync(script.filePath)) {
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
  }

  const buffer   = fs.readFileSync(script.filePath);
  const filename = encodeURIComponent(script.originalFilename);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type':        script.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(buffer.length),
    },
  });
}

// ── PUT — replace file (LeaderPrompt push) ────────────────────────────────────

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { projectId, scriptId } = await params;
  const script = getScript(projectId, scriptId);
  if (!script) return NextResponse.json({ error: 'Script not found' }, { status: 404 });
  if (!script.filePath) {
    return NextResponse.json({ error: 'No existing file path on record' }, { status: 400 });
  }

  const ext = path.extname(script.filePath).toLowerCase();
  const tmp = path.join(os.tmpdir(), `lpos-script-replace-${Date.now()}${ext}`);

  try {
    // Stream body to a temp file
    const body = req.body;
    if (!body) return NextResponse.json({ error: 'Empty body' }, { status: 400 });

    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      const src = Readable.fromWeb(body as import('stream/web').ReadableStream);
      src.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      src.on('error', reject);
    });

    // Replace the stored file in-place
    fs.renameSync(tmp, script.filePath);

    // Update file size in registry
    const newSize = fs.statSync(script.filePath).size;
    patchScript(projectId, scriptId, { fileSize: newSize });

    // Re-extract text in the background
    void extractAndSave(projectId, scriptId, script.filePath, ext);

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
