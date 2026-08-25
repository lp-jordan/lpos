import { NextRequest, NextResponse } from 'next/server';
import archiver from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import fs   from 'node:fs';
import path from 'node:path';
import { getScript } from '@/lib/store/scripts-registry';
import { getProjectById } from '@/lib/selectors/projects';

/**
 * Bulk download for a *selection* of scripts (the ScriptsTab multi-select
 * context-menu flow in components/projects/ScriptsTab.tsx). Single-file
 * downloads keep going through the existing GET
 * scripts/[scriptId]/file route.
 *
 * Behaviour mirrors ../../transcripts/download-zip (same "no zip when only
 * one" rule, same streamed-archiver pattern):
 *  - `scriptIds` length 0 → 400.
 *  - `scriptIds` length 1 → stream the raw single file (its own mimeType,
 *    no zip wrapper).
 *  - `scriptIds` length ≥ 2 → streamed .zip via `archiver`, one entry per
 *    script named by its originalFilename.
 *
 * Body: `{ scriptIds: string[] }`.
 */

function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9 _\-().]/g, '_').trim();
}

function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) { used.add(name); return name; }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let i = 1;
  while (used.has(`${base} (${i})${ext}`)) i += 1;
  const final = `${base} (${i})${ext}`;
  used.add(final);
  return final;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const project = getProjectById(projectId);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const body = await req.json() as { scriptIds?: unknown };
    if (!Array.isArray(body.scriptIds) || body.scriptIds.length === 0
        || !body.scriptIds.every((s) => typeof s === 'string')) {
      return NextResponse.json({ error: 'scriptIds (non-empty string array) is required' }, { status: 400 });
    }
    const scriptIds = body.scriptIds as string[];

    // Resolve each requested script to its on-disk file. Skip any that are
    // missing from the registry or gone from disk.
    type Resolved = { filename: string; mimeType: string; content: Buffer };
    const resolved: Resolved[] = [];
    for (const scriptId of scriptIds) {
      const script = getScript(projectId, scriptId);
      if (!script?.filePath || !fs.existsSync(script.filePath)) continue;
      resolved.push({
        filename: sanitizeForFilename(script.originalFilename) || `${scriptId}${path.extname(script.filePath)}`,
        mimeType: script.mimeType || 'application/octet-stream',
        content:  fs.readFileSync(script.filePath),
      });
    }

    if (resolved.length === 0) {
      return NextResponse.json({ error: 'No matching scripts found' }, { status: 404 });
    }

    // Single-file fast path: stream the raw file with its own mimeType.
    if (resolved.length === 1) {
      const only = resolved[0];
      return new NextResponse(only.content, {
        headers: {
          'Content-Type': only.mimeType,
          'Content-Disposition': `attachment; filename="${only.filename.replace(/"/g, '\\"')}"`,
          'Content-Length': String(only.content.length),
        },
      });
    }

    // Multi-file: streamed zip.
    const passthrough = new PassThrough();
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => passthrough.destroy(err));
    archive.pipe(passthrough);

    const used = new Set<string>();
    for (const entry of resolved) {
      archive.append(entry.content, { name: uniqueName(used, entry.filename) });
    }
    archive.finalize();

    const projectLabel = sanitizeForFilename((project.name || projectId).toString()) || projectId;
    const zipName = `scripts-${projectLabel}.zip`;

    return new NextResponse(
      Readable.toWeb(passthrough) as unknown as ReadableStream,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${zipName.replace(/"/g, '\\"')}"`,
        },
      },
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
