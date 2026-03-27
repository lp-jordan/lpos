import { NextRequest, NextResponse } from 'next/server';
import { searchTranscriptContent, TranscriptSearchError, type SearchConversationMessage } from '@/lib/transcripts/search';

type Params = { params: Promise<{ projectId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { projectId } = await params;
    const body = await req.json() as {
      query?: string;
      jobIds?: string[];
      mode?: 'selected' | 'all';
      conversation?: SearchConversationMessage[];
      threadSummary?: string;
    };

    const result = await searchTranscriptContent({
      projectId,
      query: body.query ?? '',
      jobIds: body.jobIds,
      mode: body.mode,
      conversation: body.conversation,
      threadSummary: body.threadSummary,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TranscriptSearchError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error('[transcript search POST]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
