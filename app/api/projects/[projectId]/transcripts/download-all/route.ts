import { NextRequest, NextResponse } from 'next/server';
import { listProjectTranscripts, readTranscriptText } from '@/lib/transcripts/store';
import { getProjectById } from '@/lib/selectors/projects';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!getProjectById(projectId)) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const transcripts = listProjectTranscripts(projectId);
  if (!transcripts.length) return NextResponse.json({ error: 'No transcripts found' }, { status: 404 });

  const separator = '='.repeat(60);
  const sections = transcripts.map((entry) => {
    const label = entry.filename.replace(/\.[^.]+$/, '');
    const text = readTranscriptText(projectId, entry.jobId).trim();
    return `${separator}\n${label}\n${separator}\n\n${text || '(no content)'}`;
  });

  const combined = sections.join('\n\n\n');

  return new NextResponse(combined, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="transcripts-${projectId}.txt"`,
    },
  });
}
