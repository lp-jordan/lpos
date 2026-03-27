import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TranscriptChatThread, TranscriptChatThreadSummary, TranscriptSearchMessage } from '@/lib/transcripts/types';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

interface TranscriptChatThreadFile {
  threads: TranscriptChatThread[];
}

function storePath(projectId: string): string {
  return path.join(DATA_DIR, 'projects', projectId, 'transcript-chat-threads.json');
}

function readFile(projectId: string): TranscriptChatThreadFile {
  try {
    return JSON.parse(fs.readFileSync(storePath(projectId), 'utf8')) as TranscriptChatThreadFile;
  } catch {
    return { threads: [] };
  }
}

function writeFile(projectId: string, file: TranscriptChatThreadFile): void {
  const target = storePath(projectId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(file, null, 2), 'utf8');
}

function summarizeMessages(messages: TranscriptSearchMessage[]): TranscriptSearchMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'error')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      sources: message.sources,
      usage: message.usage,
    }));
}

function deriveTitle(title: string | undefined, messages: TranscriptSearchMessage[]): string {
  if (title?.trim()) return title.trim().slice(0, 80);
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content.trim();
  if (!firstUserMessage) return 'New transcript chat';
  return firstUserMessage.slice(0, 80);
}

export function listTranscriptChatThreads(projectId: string): TranscriptChatThreadSummary[] {
  const file = readFile(projectId);
  return file.threads
    .map((thread) => ({
      threadId: thread.threadId,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      scope: thread.scope,
      messageCount: thread.messages.length,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getTranscriptChatThread(projectId: string, threadId: string): TranscriptChatThread | null {
  const file = readFile(projectId);
  return file.threads.find((thread) => thread.threadId === threadId) ?? null;
}

export function createTranscriptChatThread(projectId: string, input?: {
  title?: string;
  scope?: { mode: 'selected' | 'all'; jobIds: string[] };
}): TranscriptChatThread {
  const file = readFile(projectId);
  const now = new Date().toISOString();
  const thread: TranscriptChatThread = {
    threadId: randomUUID(),
    title: input?.title?.trim() || 'New transcript chat',
    createdAt: now,
    updatedAt: now,
    scope: {
      mode: input?.scope?.mode ?? 'all',
      jobIds: input?.scope?.jobIds ?? [],
    },
    threadSummary: '',
    messages: [],
  };
  file.threads.push(thread);
  writeFile(projectId, file);
  return thread;
}

export function saveTranscriptChatThread(projectId: string, input: {
  threadId?: string;
  title?: string;
  scope: { mode: 'selected' | 'all'; jobIds: string[] };
  threadSummary?: string;
  messages: TranscriptSearchMessage[];
}): TranscriptChatThread {
  const file = readFile(projectId);
  const now = new Date().toISOString();
  const existingIndex = input.threadId
    ? file.threads.findIndex((thread) => thread.threadId === input.threadId)
    : -1;

  const nextThread: TranscriptChatThread = {
    threadId: existingIndex >= 0 ? file.threads[existingIndex]!.threadId : randomUUID(),
    title: deriveTitle(input.title, input.messages),
    createdAt: existingIndex >= 0 ? file.threads[existingIndex]!.createdAt : now,
    updatedAt: now,
    scope: input.scope,
    threadSummary: input.threadSummary?.trim() ?? '',
    messages: summarizeMessages(input.messages),
  };

  if (existingIndex >= 0) {
    file.threads[existingIndex] = nextThread;
  } else {
    file.threads.push(nextThread);
  }

  writeFile(projectId, file);
  return nextThread;
}

export function deleteTranscriptChatThread(projectId: string, threadId: string): boolean {
  const file = readFile(projectId);
  const nextThreads = file.threads.filter((thread) => thread.threadId !== threadId);
  if (nextThreads.length === file.threads.length) return false;
  writeFile(projectId, { threads: nextThreads });
  return true;
}
