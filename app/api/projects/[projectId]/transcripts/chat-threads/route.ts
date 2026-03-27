import { NextRequest, NextResponse } from 'next/server';
import {
  createTranscriptChatThread,
  listTranscriptChatThreads,
} from '@/lib/store/transcript-chat-store';

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_: NextRequest, { params }: Params) {
  const { projectId } = await params;
  return NextResponse.json({ threads: listTranscriptChatThreads(projectId) });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const body = await req.json().catch(() => ({})) as {
    title?: string;
    scope?: { mode?: 'selected' | 'all'; jobIds?: string[] };
  };
  const thread = createTranscriptChatThread(projectId, {
    title: body.title,
    scope: {
      mode: body.scope?.mode ?? 'all',
      jobIds: body.scope?.jobIds ?? [],
    },
  });
  return NextResponse.json({ thread }, { status: 201 });
}
