/**
 * /api/projects/[projectId]/scripts/[scriptId]/content
 *
 * GET — return the HTML sidecar (extracted from the stored .docx / pdf / txt).
 *       Used by the LPOS editor panel to populate the editable view.
 *
 * PUT — accept edited HTML, save the sidecar, AND regenerate the .docx so that
 *       LeaderPrompt's next poll picks up the changes via GET /file.
 *       Also bumps updatedAt so LP's staleness check fires correctly.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs   from 'node:fs';
import path from 'node:path';
import { getScript, getExtractedText, saveExtractedText, patchScript } from '@/lib/store/scripts-registry';

type Ctx = { params: Promise<{ projectId: string; scriptId: string }> };

// ── GET — fetch HTML content ──────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, scriptId } = await params;
  const script = getScript(projectId, scriptId);
  if (!script) return NextResponse.json({ error: 'Script not found' }, { status: 404 });

  const html = getExtractedText(projectId, scriptId);
  if (html === null) {
    return NextResponse.json({ error: 'No content available' }, { status: 404 });
  }

  return NextResponse.json({ html });
}

// ── PUT — save edited HTML + regenerate .docx ────────────────────────────────

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { projectId, scriptId } = await params;
  const script = getScript(projectId, scriptId);
  if (!script) return NextResponse.json({ error: 'Script not found' }, { status: 404 });

  let body: { html?: string };
  try {
    body = await req.json() as { html?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.html !== 'string') {
    return NextResponse.json({ error: '"html" field required' }, { status: 400 });
  }

  // Save the HTML sidecar
  saveExtractedText(projectId, scriptId, body.html);
  patchScript(projectId, scriptId, { hasExtractedText: true });

  // Regenerate the .docx from the HTML so LP's GET /file returns updated content.
  // We write back to the same filePath so the existing record stays valid.
  if (script.filePath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const htmlToDocxMod = await import('html-to-docx') as any;
      const htmlToDocx    = htmlToDocxMod.default ?? htmlToDocxMod;
      const buffer        = await htmlToDocx(body.html, undefined, {
        title: script.name,
      }) as Buffer;

      // Ensure the target directory exists
      fs.mkdirSync(path.dirname(script.filePath), { recursive: true });

      // If the original was a PDF or TXT, write a new .docx alongside it
      const ext        = path.extname(script.filePath).toLowerCase();
      const targetPath = ext === '.docx'
        ? script.filePath
        : script.filePath.replace(/\.[^.]+$/, '.docx');

      fs.writeFileSync(targetPath, Buffer.from(buffer));

      // Keep registry in sync (path may have changed for non-docx originals)
      const newSize = fs.statSync(targetPath).size;
      patchScript(projectId, scriptId, {
        filePath: targetPath,
        fileSize: newSize,
      });
    } catch (err) {
      // Log but don't fail the request — text was saved, docx regen is best-effort
      console.error('[content PUT] docx regen failed:', err);
    }
  }

  // patchScript already bumped updatedAt — LP's poll will detect the change
  const updated = getScript(projectId, scriptId);
  return NextResponse.json({ ok: true, updatedAt: updated?.updatedAt });
}
