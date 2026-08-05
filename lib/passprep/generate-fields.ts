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
const DESCRIPTION_SYSTEM = 'You write course-lesson video descriptions for a leadership platform. Follow every rule below exactly. Return only the description prose — no preamble, no quotes, no labels.';

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

const ASSET_DIR = path.join(process.cwd(), 'lib', 'passprep', 'assets');

// Cached asset reader — style files are editable without a redeploy (cache is
// per-process, so a server restart picks up edits).
const _assetCache = new Map<string, string>();
function readAsset(file: string): string {
  if (!_assetCache.has(file)) {
    try { _assetCache.set(file, fs.readFileSync(path.join(ASSET_DIR, file), 'utf8').trim()); }
    catch { _assetCache.set(file, ''); }
  }
  return _assetCache.get(file) ?? '';
}

/** Titles use the shared house style. */
function withHouseStyle(system: string): string {
  const style = readAsset('house-style.md');
  return style ? `${system}\n\nHouse style:\n${style}` : system;
}
/** Descriptions use their own detailed rules file. */
function withDescriptionStyle(system: string): string {
  const style = readAsset('description-style.md');
  return style ? `${system}\n\n${style}` : system;
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

/**
 * Description cleanup + "no dashes" enforcement (the model still slips em-dashes
 * in sometimes). Em/en dashes and dash-style spaced hyphens become commas;
 * hyphens inside words (e.g. "high-potential") are kept.
 */
export function cleanDescription(raw: string): string {
  let s = cleanLine(raw, 500);
  s = s.replace(/\s*[—–]\s*/g, ', ').replace(/\s+-\s+/g, ', ');
  // tidy any doubled/space-before punctuation the swap can create
  s = s.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])\s*[,;:]+/g, '$1').replace(/,\s*\./g, '.');
  return s.trim();
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
  // Detailed rules (audience, 2 sentences, banned words, no dashes, etc.) come
  // from description-style.md via withDescriptionStyle().
  const prompt = [
    'Write the 2 sentence description for this lesson video, based only on the transcript below.',
    input.title ? `Working title: ${input.title}.` : '',
    '',
    'Transcript excerpt:',
    sampleTranscript(input.transcript),
  ].filter(Boolean).join('\n');
  const out = await callModel(prompt, provider, withDescriptionStyle(DESCRIPTION_SYSTEM));
  const description = cleanDescription(out);
  if (!description) throw new GenerateFieldError('Model returned an empty description.');
  return description;
}
