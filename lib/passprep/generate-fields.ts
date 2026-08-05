/**
 * Single-video title/description generation from a transcript.
 *
 * Reuses the provider-routed transport in `generate-plan.ts` (`callModel`) and
 * `inferAiProvider` from `core.ts`, without the course-plan/tree wrapper. Used by
 * the Pass Prep enrichment route and the per-tile regenerate actions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { inferAiProvider, type AiProvider } from './core';
import { callModel } from './generate-plan';

export class GenerateFieldError extends Error {}

const TITLE_SYSTEM = 'You write concise, specific course-lesson titles. Return only the title text — no quotes, no trailing punctuation, no preamble.';
const DESCRIPTION_SYSTEM = 'You write concise, practical course-lesson descriptions grounded strictly in the transcript. Return only the description prose — no preamble, no quotes.';

// Transcript sampling: keep the beginning (states the topic) AND the end (states
// the takeaway) rather than a head-only window that drops the conclusion on long
// videos. Whole transcript is sent when it already fits the budget.
const HEAD_CHARS = 4000;
const TAIL_CHARS = 2000;

export function sampleTranscript(text: string): string {
  const t = (text ?? '').trim();
  if (t.length <= HEAD_CHARS + TAIL_CHARS + 40) return t; // already fits — send whole
  const head = t.slice(0, HEAD_CHARS).replace(/\s+\S*$/, '');            // don't cut mid-word
  const tail = t.slice(t.length - TAIL_CHARS).replace(/^\S*\s+/, '');    // resume at a word start
  return `${head}\n\n[… middle of transcript trimmed …]\n\n${tail}`;
}

// Shared house style (same file the old course-plan generator used). Cached once.
const HOUSE_STYLE_PATH = path.join(process.cwd(), 'lib', 'passprep', 'assets', 'house-style.md');
let _houseStyle: string | null = null;
function houseStyle(): string {
  if (_houseStyle === null) {
    try { _houseStyle = fs.readFileSync(HOUSE_STYLE_PATH, 'utf8').trim(); }
    catch { _houseStyle = ''; }
  }
  return _houseStyle;
}
/** Append the house style to a base system prompt (no-op if the file is missing). */
function withHouseStyle(system: string): string {
  const style = houseStyle();
  return style ? `${system}\n\nHouse style:\n${style}` : system;
}

function requireProvider(): AiProvider {
  const provider = inferAiProvider();
  if (!provider) throw new GenerateFieldError('No AI provider configured (set CLAUDE_API_KEY or OPENAI_API_KEY).');
  return provider;
}

/** Collapse whitespace, strip wrapping quotes, cap length. */
function cleanLine(raw: string, maxLen: number): string {
  let s = (raw ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/\s+\S*$/, '').trim();
  return s;
}

export async function generateTitleFromTranscript(input: { transcript: string; code?: string | null }): Promise<string> {
  const provider = requireProvider();
  const prompt = [
    'Generate a concise, specific lesson title (about 3–8 words) for this video, grounded in its transcript.',
    input.code ? `Source code: ${input.code}.` : '',
    'Return ONLY the title.',
    '',
    'Transcript excerpt:',
    sampleTranscript(input.transcript),
  ].filter(Boolean).join('\n');
  const out = await callModel(prompt, provider, withHouseStyle(TITLE_SYSTEM));
  const title = cleanLine(out, 90);
  if (!title) throw new GenerateFieldError('Model returned an empty title.');
  return title;
}

export async function generateDescriptionFromTranscript(input: { transcript: string; title?: string | null }): Promise<string> {
  const provider = requireProvider();
  const prompt = [
    'Write a 1–2 sentence description of this lesson video, practical and grounded strictly in the transcript.',
    input.title ? `Working title: ${input.title}.` : '',
    'Return ONLY the description prose.',
    '',
    'Transcript excerpt:',
    sampleTranscript(input.transcript),
  ].filter(Boolean).join('\n');
  const out = await callModel(prompt, provider, withHouseStyle(DESCRIPTION_SYSTEM));
  const description = cleanLine(out, 400);
  if (!description) throw new GenerateFieldError('Model returned an empty description.');
  return description;
}
