/**
 * Single-video title/description generation from a transcript.
 *
 * Reuses the provider-routed transport in `generate-plan.ts` (`callModel`) and
 * `inferAiProvider` from `core.ts`, without the course-plan/tree wrapper. Used by
 * the Pass Prep enrichment route and the per-tile regenerate actions.
 */

import { inferAiProvider, type AiProvider } from './core';
import { callModel } from './generate-plan';

export class GenerateFieldError extends Error {}

const TITLE_SYSTEM = 'You write concise, specific course-lesson titles. Return only the title text — no quotes, no trailing punctuation, no preamble.';
const DESCRIPTION_SYSTEM = 'You write concise, practical course-lesson descriptions grounded strictly in the transcript. Return only the description prose — no preamble, no quotes.';
const TRANSCRIPT_CHARS = 6000;

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
    input.transcript.slice(0, TRANSCRIPT_CHARS),
  ].filter(Boolean).join('\n');
  const out = await callModel(prompt, provider, TITLE_SYSTEM);
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
    input.transcript.slice(0, TRANSCRIPT_CHARS),
  ].filter(Boolean).join('\n');
  const out = await callModel(prompt, provider, DESCRIPTION_SYSTEM);
  const description = cleanLine(out, 400);
  if (!description) throw new GenerateFieldError('Model returned an empty description.');
  return description;
}
