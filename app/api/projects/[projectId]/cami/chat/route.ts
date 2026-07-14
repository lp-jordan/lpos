import { NextRequest } from 'next/server';
import { runCamiChat, type CamiChatInput } from '@/lib/cami/chat';

type Params = { params: Promise<{ projectId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  let body: {
    message?: string;
    conversation?: { role: 'user' | 'assistant'; content: string }[];
    jobIds?: string[];
    scopeMode?: 'selected' | 'all';
    threadSummary?: string;
  };

  try {
    body = await req.json() as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 });
  }

  if (!body.message?.trim()) {
    return new Response(JSON.stringify({ error: 'message is required' }), { status: 400 });
  }

  const encoder = new TextEncoder();

  function makeEvent(event: object): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  }

  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: object) => {
        if (closed) return;
        try { controller.enqueue(makeEvent(event)); } catch { closed = true; }
      };
      try {
        const chatInput: CamiChatInput = {
          projectId,
          message: body.message!.trim(),
          conversation: body.conversation ?? [],
          jobIds: body.jobIds ?? [],
          scopeMode: body.scopeMode ?? 'all',
          threadSummary: body.threadSummary,
        };

        const result = await runCamiChat(chatInput, (statusText) => {
          emit({ type: 'status', text: statusText });
        });

        emit({
          type: 'done',
          answer: result.answer,
          sources: result.sources,
          threadSummary: result.threadSummary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Cami chat failed.';
        console.error('[cami chat]', message);
        emit({ type: 'error', text: message });
      } finally {
        if (!closed) { closed = true; try { controller.close(); } catch {} }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
