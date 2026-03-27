import { NextRequest, NextResponse } from 'next/server';
import {
  deleteTranscriptChatThread,
  getTranscriptChatThread,
  saveTranscriptChatThread,
} from '@/lib/store/transcript-chat-store';
import type { TranscriptSearchMessage } from '@/lib/transcripts/types';

type Params = { params: Promise<{ projectId: string; threadId: string }> };

export async function GET(_: NextRequest, { params }: Params) {
  const { projectId, threadId } = await params;
  const thread = getTranscriptChatThread(projectId, threadId);
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
  return NextResponse.json({ thread });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { projectId, threadId } = await params;
  const body = await req.json() as {
    title?: string;
    scope: { mode: 'selected' | 'all'; jobIds: string[] };
    threadSummary?: string;
    messages: TranscriptSearchMessage[];
  };

  const thread = saveTranscriptChatThread(projectId, {
    threadId,
    title: body.title,
    scope: body.scope,
    threadSummary: body.threadSummary,
    messages: body.messages,
  });

  return NextResponse.json({ thread });
}

export async function DELETE(_: NextRequest, { params }: Params) {
  const { projectId, threadId } = await params;
  const deleted = deleteTranscriptChatThread(projectId, threadId);
  if (!deleted) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
