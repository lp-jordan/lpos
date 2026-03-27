import { NextRequest, NextResponse } from 'next/server';
import { listProjectTranscripts, readTranscriptDownload } from '@/lib/transcripts/store';

export type { TranscriptEntry } from '@/lib/transcripts/types';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const { searchParams } = new URL(req.url);
  const download = searchParams.get('download');
  const type = searchParams.get('type');

  if (download && (type === 'txt' || type === 'json' || type === 'srt' || type === 'vtt')) {
    const content = readTranscriptDownload(projectId, download, type);
    if (!content) return NextResponse.json({ error: 'File not found' }, { status: 404 });

    const mimeTypes: Record<typeof type, string> = {
      txt: 'text/plain',
      json: 'application/json',
      srt: 'text/plain',
      vtt: 'text/vtt',
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
