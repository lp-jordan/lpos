import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

const DOCS_DIR = path.join(process.cwd(), '../docs');
const CHANGELOG_PATH = path.join(DOCS_DIR, 'changelog.json');
const CACHE_PATH = path.join(DOCS_DIR, 'changelog-cache.json');

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';

interface ChangelogEntry {
  timestamp: string;
  title: string;
  summary: string;
}

interface Cache {
  date: string;
  bullets: string[];
}

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);

  let entries: ChangelogEntry[] = [];
  try {
    const raw = await fs.readFile(CHANGELOG_PATH, 'utf-8');
    entries = JSON.parse(raw);
  } catch {
    // No changelog yet
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = entries.filter(e => new Date(e.timestamp).getTime() > cutoff);

  if (recent.length === 0) {
    return NextResponse.json({ hasContent: false, bullets: [], date: today });
  }

  try {
    const cacheRaw = await fs.readFile(CACHE_PATH, 'utf-8');
    const cache: Cache = JSON.parse(cacheRaw);
    if (cache.date === today && cache.bullets.length > 0) {
      return NextResponse.json({ hasContent: true, bullets: cache.bullets, date: today });
    }
  } catch {
    // No cache yet
  }

  const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  const input = recent.map(e => `• ${e.title}: ${e.summary}`).join('\n');

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: 'You rewrite technical developer change log entries as short, friendly bullet points for end users of a production software platform. Focus on what changed for the user, not the technical implementation. Use plain, conversational language. Avoid jargon. Keep each bullet under 20 words. Return only a JSON array of strings — no markdown, no explanation.',
    messages: [{ role: 'user', content: `Rewrite these changes as user-friendly bullet points:\n${input}` }],
  });

  let bullets: string[] = [];
  const content = message.content[0];
  if (content.type === 'text') {
    try {
      bullets = JSON.parse(content.text);
    } catch {
      bullets = content.text
        .split('\n')
        .map(l => l.replace(/^[\s•\-*]+/, '').trim())
        .filter(Boolean);
    }
  }

  const cache: Cache = { date: today, bullets };
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));

  return NextResponse.json({ hasContent: true, bullets, date: today });
}
