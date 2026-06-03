import { NextRequest, NextResponse } from 'next/server';
import archiver from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';
import { listProjectTranscripts, readTranscriptText } from '@/lib/transcripts/store';
import { getProjectById } from '@/lib/selectors/projects';

/**
 * Bulk transcript download.
 *
 * Behavior, intentionally browser/OS-agnostic:
 *  - Zero transcripts → 404.
 *  - **Exactly one** transcript → stream the raw `.txt` directly (no zip wrapper —
 *    a single-file zip would be busywork for the user).
 *  - **Two or more** transcripts → stream a `.zip` built with `archiver` (same
 *    streaming pattern as `photos/download-zip`), one `.txt` per transcript named
 *    by the transcript's display filename with collision-safe deduping.
 */

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

function sanitizeForFilename(s: string): string {
  // Drop characters that browsers/OSes object to in a Content-Disposition filename
  // or in a file inside a zip. Keep spaces, letters, digits, dash, underscore, dot, parens.
  return s.replace(/[^a-zA-Z0-9 _\-().]/g, '_').trim();
}

function ensureTxtName(name: string): string {
  const cleaned = sanitizeForFilename(name.replace(/\.[^.]+$/, '')) || 'transcript';
  return `${cleaned}.txt`;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const project = getProjectById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const transcripts = listProjectTranscripts(projectId);
  if (!transcripts.length) return NextResponse.json({ error: 'No transcripts found' }, { status: 404 });

  // Project name (or projectId fallback) for the outer download name.
  const projectLabel = sanitizeForFilename((project.name || projectId).toString()) || projectId;

  // Single-transcript fast path: stream the raw .txt, no zip wrapper.
  if (transcripts.length === 1) {
    const only = transcripts[0];
    const text = readTranscriptText(projectId, only.jobId).trim() || '(no content)';
    const downloadName = ensureTxtName(only.filename);
    return new NextResponse(text, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${downloadName.replace(/"/g, '\\"')}"`,
      },
    });
  }

  // Multi-transcript: streamed zip.
  const passthrough = new PassThrough();
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => passthrough.destroy(err));
  archive.pipe(passthrough);

  const used = new Set<string>();
  for (const entry of transcripts) {
    const text = readTranscriptText(projectId, entry.jobId).trim() || '(no content)';
    const name = uniqueName(used, ensureTxtName(entry.filename));
    archive.append(text, { name });
  }
  archive.finalize();

  const zipName = `transcripts-${projectLabel}.zip`;

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
}
