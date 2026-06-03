import { NextRequest, NextResponse } from 'next/server';
import archiver from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';
import {
  readTranscriptDownload,
  resolveTranscriptDisplayName,
} from '@/lib/transcripts/store';
import { getProjectById } from '@/lib/selectors/projects';

/**
 * Bulk download for a *selection* of transcripts (the in-list "batch bar" flow
 * in components/projects/ProjectDetail.tsx). The "Download all" entrypoint
 * lives at ../download-all/route.ts — same archiver pattern, different selector.
 *
 * Behaviour, intentionally browser/OS-agnostic:
 *  - `jobIds` length 0 → 400.
 *  - `jobIds` length 1 → stream the raw single file (no zip wrapper — matches
 *    the user-stated "no zip when only one" rule, and keeps parity with the
 *    single-file GET /transcripts?download=jobId&type=… route's response shape).
 *  - `jobIds` length ≥ 2 → streamed .zip via `archiver`, one entry per jobId.
 *
 * Body: `{ jobIds: string[]; type: 'txt' | 'timecoded-txt' }`.
 * Only those two `type`s are supported: the batch bar exposes only TXT and
 * Timecoded TXT. Single-file SRT/VTT/JSON downloads keep going through the
 * existing GET /transcripts?download=jobId&type=… route.
 */

const ALLOWED_TYPES = new Set(['txt', 'timecoded-txt'] as const);
type BulkType = 'txt' | 'timecoded-txt';

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

/** Mirrors the naming convention used by the single-file route:
 *  txt → "<displayName>.txt", timecoded-txt → "<displayName>-timecoded.txt". */
function buildEntryName(displayName: string, type: BulkType, fallback: string): string {
  const baseRaw = displayName.replace(/\.[^.]+$/, '');
  const base = sanitizeForFilename(baseRaw) || fallback;
  const suffix = type === 'timecoded-txt' ? '-timecoded' : '';
  return `${base}${suffix}.txt`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const project = getProjectById(projectId);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const body = await req.json() as { jobIds?: unknown; type?: unknown };
    if (!Array.isArray(body.jobIds) || body.jobIds.length === 0
        || !body.jobIds.every((j) => typeof j === 'string')) {
      return NextResponse.json({ error: 'jobIds (non-empty string array) is required' }, { status: 400 });
    }
    if (typeof body.type !== 'string' || !ALLOWED_TYPES.has(body.type as BulkType)) {
      return NextResponse.json({ error: `type must be one of: ${[...ALLOWED_TYPES].join(', ')}` }, { status: 400 });
    }
    const type = body.type as BulkType;
    const jobIds = body.jobIds as string[];

    // Resolve every requested transcript to (jobId, displayName, buffer). Skip
    // any that fail to load (e.g. timecoded-txt requested on a transcript with
    // no JSON source — exactly mirrors the single-file route's `null` skip).
    type Resolved = { jobId: string; displayName: string; content: Buffer };
    const resolved: Resolved[] = [];
    for (const jobId of jobIds) {
      const content = readTranscriptDownload(projectId, jobId, type);
      if (!content) continue;
      const displayName = resolveTranscriptDisplayName(projectId, jobId);
      resolved.push({ jobId, displayName, content });
    }

    if (resolved.length === 0) {
      return NextResponse.json({ error: 'No matching transcripts found' }, { status: 404 });
    }

    // Single-file fast path: stream the raw .txt.
    if (resolved.length === 1) {
      const only = resolved[0];
      const name = buildEntryName(only.displayName, type, only.jobId);
      return new NextResponse(only.content, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name.replace(/"/g, '\\"')}"`,
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
      const name = uniqueName(used, buildEntryName(entry.displayName, type, entry.jobId));
      archive.append(entry.content, { name });
    }
    archive.finalize();

    const projectLabel = sanitizeForFilename((project.name || projectId).toString()) || projectId;
    const typeSuffix = type === 'timecoded-txt' ? '-timecoded' : '';
    const zipName = `transcripts-${projectLabel}${typeSuffix}.zip`;

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
