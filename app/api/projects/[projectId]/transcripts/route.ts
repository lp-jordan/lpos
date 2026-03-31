import { NextRequest, NextResponse } from 'next/server';
import { listProjectTranscripts, readTranscriptDownload, getTranscriptPaths } from '@/lib/transcripts/store';
import fs from 'node:fs';
import { getProjectById } from '@/lib/selectors/projects';

export type { TranscriptEntry } from '@/lib/transcripts/types';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const { searchParams } = new URL(req.url);
  const download = searchParams.get('download');
  const type = searchParams.get('type');

  if (download && (type === 'txt' || type === 'json' || type === 'srt' || type === 'vtt' || type === 'timecoded-txt')) {
    const content = readTranscriptDownload(projectId, download, type);
    if (!content) return NextResponse.json({ error: 'File not found' }, { status: 404 });

    const mimeTypes: Record<typeof type, string> = {
      txt: 'text/plain',
      json: 'application/json',
      srt: 'text/plain',
      vtt: 'text/vtt',
      'timecoded-txt': 'text/plain',
    };

    return new NextResponse(content, {
      headers: {
        'Content-Type': mimeTypes[type],
        'Content-Disposition': `attachment; filename="${download}.${type}"`,
      },
    });
  }

  return NextResponse.json({ transcripts: listProjectTranscripts(projectId) });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  if (!getProjectById(projectId)) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const body = await req.json() as { jobIds?: unknown };
  if (!Array.isArray(body.jobIds) || body.jobIds.length === 0) {
    return NextResponse.json({ error: 'jobIds required' }, { status: 400 });
  }

  let deleted = 0;
  for (const jobId of body.jobIds) {
    if (typeof jobId !== 'string') continue;
    const { txtPath, jsonPath, srtPath, vttPath, metaPath } = getTranscriptPaths(projectId, jobId);
    for (const filePath of [txtPath, jsonPath, metaPath, srtPath, vttPath]) {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    }
    deleted++;
  }

  return NextResponse.json({ deleted });
}
