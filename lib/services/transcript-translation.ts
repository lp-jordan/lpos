import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getTranscriptPaths } from '@/lib/transcripts/store';
import { recordLlmUsage } from '@/lib/store/llm-usage-store';

/**
 * Produces a Spanish transcript by TRANSLATING an existing English transcript,
 * not by re-transcribing audio (whisper cannot translate EN→ES). Each English
 * segment's timestamps are preserved exactly and only its text is translated,
 * so the Spanish captions are frame-locked to the same speech as English.
 */

// Sonnet 5 by default (user choice); overridable without a redeploy.
const TRANSLATION_MODEL = process.env.LPOS_TRANSLATION_MODEL ?? 'claude-sonnet-5';
// Segments per Claude call. Small batches keep each call well under max_tokens
// and make the 1:1 length check reliable.
const BATCH_SIZE = 40;

interface WhisperSegment {
  timestamps: { from: string; to: string };
  offsets: { from: number; to: number };
  text: string;
}
interface WhisperJson {
  transcription: WhisperSegment[];
  [key: string]: unknown;
}

export interface TranslationResult {
  txtPath: string;
  jsonPath: string;
  srtPath: string;
  vttPath: string;
  segmentCount: number;
}

const SYSTEM_PROMPT =
  'You are a professional subtitle translator. Translate English video captions into natural, fluent Latin American Spanish. ' +
  'Translate meaning and tone rather than word-for-word, and keep each line concise enough to read as a subtitle. ' +
  'You will receive a JSON array of English caption segments. Return ONLY a JSON array of the SAME length, in the SAME order, ' +
  'where each element is the Spanish translation of the corresponding English element. ' +
  'Do not merge, split, add, drop, renumber, or annotate elements. Output the JSON array and nothing else.';

function stripCodeFence(text: string): string {
  const t = text.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  return t;
}

/** Translate one batch of segment texts → same-length Spanish array. Throws on
 *  an unrecoverable length mismatch after one retry. Accumulates token usage. */
async function translateBatch(
  client: Anthropic,
  texts: string[],
  usageAcc: { input: number; output: number; cacheRead: number; cacheCreate: number },
): Promise<string[]> {
  const payload = JSON.stringify(texts.map((t) => t.trim()));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await client.messages.create({
      model: TRANSLATION_MODEL,
      max_tokens: 8000,
      // Deterministic transform — no reasoning needed; disabling thinking cuts
      // cost/latency (Sonnet 5 runs adaptive thinking by default otherwise).
      thinking: { type: 'disabled' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: payload }],
    });

    usageAcc.input += response.usage.input_tokens ?? 0;
    usageAcc.output += response.usage.output_tokens ?? 0;
    usageAcc.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usageAcc.cacheCreate += response.usage.cache_creation_input_tokens ?? 0;

    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    try {
      const parsed = JSON.parse(stripCodeFence(raw)) as unknown;
      if (Array.isArray(parsed) && parsed.length === texts.length && parsed.every((x) => typeof x === 'string')) {
        return parsed as string[];
      }
    } catch {
      // fall through to retry
    }
  }
  throw new Error(`Translation returned a mismatched or invalid batch (expected ${texts.length} segments).`);
}

/** Build an SRT body from translated segments (comma-millisecond timestamps as whisper emits). */
function buildSrt(segments: WhisperSegment[], texts: string[]): string {
  return segments
    .map((seg, i) => `${i + 1}\n${seg.timestamps.from} --> ${seg.timestamps.to}\n${texts[i].trim()}\n`)
    .join('\n');
}

/** Build a WEBVTT body (dot-millisecond timestamps). */
function buildVtt(segments: WhisperSegment[], texts: string[]): string {
  const cues = segments
    .map((seg) => {
      const from = seg.timestamps.from.replace(',', '.');
      const to = seg.timestamps.to.replace(',', '.');
      return `${from} --> ${to}`;
    })
    .map((cue, i) => `${cue}\n${texts[i].trim()}`)
    .join('\n\n');
  return `WEBVTT\n\n${cues}\n`;
}

export async function translateTranscriptToSpanish(opts: {
  projectId: string;
  assetId?: string;
  englishJobId: string;
  spanishJobId: string;
  projectDir: string;
}): Promise<TranslationResult> {
  const apiKey = process.env.CLAUDE_API_KEY?.trim();
  if (!apiKey) throw new Error('CLAUDE_API_KEY is not configured — Spanish translation requires it.');

  const enPaths = getTranscriptPaths(opts.projectId, opts.englishJobId);
  if (!fs.existsSync(enPaths.jsonPath)) {
    throw new Error(`English transcript JSON not found at ${enPaths.jsonPath}.`);
  }
  const rawJson = JSON.parse(fs.readFileSync(enPaths.jsonPath, 'utf8')) as WhisperJson;
  const segments = Array.isArray(rawJson.transcription) ? rawJson.transcription : [];
  if (segments.length === 0) throw new Error('English transcript has no segments to translate.');

  const client = new Anthropic({ apiKey });
  const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

  // Translate in order, batch by batch, preserving 1:1 segment alignment.
  const translated: string[] = [];
  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    const batch = segments.slice(i, i + BATCH_SIZE).map((s) => s.text);
    const out = await translateBatch(client, batch, usageAcc);
    translated.push(...out);
  }

  // Record exact usage/cost for the whole translation (one row per asset run).
  recordLlmUsage({
    feature: 'spanish_translation',
    model: TRANSLATION_MODEL,
    projectId: opts.projectId,
    assetId: opts.assetId ?? null,
    jobId: opts.spanishJobId,
    usage: {
      input_tokens: usageAcc.input,
      output_tokens: usageAcc.output,
      cache_read_input_tokens: usageAcc.cacheRead,
      cache_creation_input_tokens: usageAcc.cacheCreate,
    },
  });

  // ── Write the Spanish outputs at the Spanish jobId prefix ──────────────────
  const transcriptsDir = path.join(opts.projectDir, 'transcripts');
  const subtitlesDir = path.join(opts.projectDir, 'subtitles');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(subtitlesDir, { recursive: true });

  const spPaths = getTranscriptPaths(opts.projectId, opts.spanishJobId);

  // JSON: same structure as whisper output (so the timecoded view + enumeration
  // keep working), with translated text and language flipped to 'es'.
  const spanishSegments: WhisperSegment[] = segments.map((seg, i) => ({
    ...seg,
    text: ` ${translated[i].trim()}`, // leading space mirrors whisper's format
  }));
  const spanishJson: WhisperJson = {
    ...rawJson,
    result: { ...(rawJson.result as Record<string, unknown> ?? {}), language: 'es' },
    transcription: spanishSegments,
  };
  fs.writeFileSync(spPaths.jsonPath, JSON.stringify(spanishJson, null, 2));
  fs.writeFileSync(spPaths.txtPath, spanishSegments.map((s) => s.text.trim()).join('\n') + '\n');
  fs.writeFileSync(spPaths.srtPath, buildSrt(segments, translated));
  fs.writeFileSync(spPaths.vttPath, buildVtt(segments, translated));

  return {
    txtPath: spPaths.txtPath,
    jsonPath: spPaths.jsonPath,
    srtPath: spPaths.srtPath,
    vttPath: spPaths.vttPath,
    segmentCount: segments.length,
  };
}
