import type { TranscriptEntry, TranscriptSearchResponse, TranscriptSearchSource } from './types';
import { listProjectTranscripts, readTranscriptText } from './store';

const CLAUDE_URL = process.env.CLAUDE_BASE_URL ?? 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = 45000;
const MAX_TRANSCRIPTS_PER_REQUEST = 100;
const MAX_CHARS_PER_CHUNK = 900;
const MAX_CHUNKS_PER_TRANSCRIPT = 6;
const MAX_CHUNKS_TOTAL = 24;
const MAX_EVIDENCE_CHARS = 32000;
const MAX_CONVERSATION_TURNS = 4;

const LOCAL_CONTEXT_RADIUS = 300;
const LOCAL_MAX_MATCHES_PER_TRANSCRIPT = 10;
const LOCAL_MAX_MATCHES_TOTAL = 60;

export interface SearchConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface TranscriptRecord extends TranscriptEntry {
  text: string;
}

interface TranscriptChunk {
  id: string;
  jobId: string;
  filename: string;
  text: string;
  score: number;
}

interface LocalMatch {
  jobId: string;
  filename: string;
  excerpt: string;
  matchIndex: number;
}

interface ClaudeSearchPayload {
  answer?: string;
  summary?: string;
  bullets?: string[];
  citationIds?: string[];
  threadSummary?: string;
}

function isClaudeSearchPayload(value: unknown): value is ClaudeSearchPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.answer !== 'string' && typeof record.summary !== 'string') return false;
  if (record.bullets !== undefined && !Array.isArray(record.bullets)) return false;
  if (record.citationIds !== undefined && !Array.isArray(record.citationIds)) return false;
  if (record.threadSummary !== undefined && typeof record.threadSummary !== 'string') return false;
  return true;
}

export class TranscriptSearchError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function tokenize(input: string): string[] {
  return normalizeText(input)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function uniqueTokens(input: string): string[] {
  return [...new Set(tokenize(input))];
}

function detectQuoteIntent(query: string): boolean {
  return /\b(quote|quoted|verbatim|exact words|exact phrase|say exactly)\b/i.test(query);
}

function detectListIntent(query: string): boolean {
  return /\b(list|bullet|bulleted|bullet pointed|every|all|instances|places|where does|where does he|where does she)\b/i.test(query);
}

type ClassifyResult =
  | { mode: 'find'; terms: string[] }
  | { mode: 'ask' }
  | { mode: 'clarify'; question: string };

function isClassifyResult(value: unknown): value is ClassifyResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.mode === 'ask') return true;
  if (record.mode === 'find') return Array.isArray(record.terms) && (record.terms as unknown[]).length > 0;
  if (record.mode === 'clarify') return typeof record.question === 'string' && record.question.length > 0;
  return false;
}

async function classifyQuery(
  query: string,
  conversation: SearchConversationMessage[],
): Promise<ClassifyResult> {
  const apiKey = process.env.CLAUDE_API_KEY?.trim();
  if (!apiKey) return { mode: 'ask' };

  const system = [
    'You are a search intent classifier for a video course transcript search tool.',
    'Classify the query using conversation history for context.',
    '',
    '"find" — The user wants to locate specific words, names, or exact phrases in the transcript text.',
    '  Extract ONLY the content being searched for — the word, phrase, or name that should appear verbatim in the transcript.',
    '  Do NOT include speaker names, subject names, or question words as terms.',
    '  Example: "where does Boo say cryptiter" → terms: ["cryptiter"]',
    '  Example: "find mentions of machine learning" → terms: ["machine learning"]',
    '  Example: "what does the instructor say about REST APIs" → mode: ask (needs context, not a verbatim find)',
    '"ask" — The user wants analysis, synthesis, summary, or any contextual understanding. Default to this when in doubt.',
    '"clarify" — Use sparingly. Only when the intent is genuinely unresolvable from the query and conversation history.',
    '',
    'Return strict JSON only. No markdown. No explanation.',
    '{"mode":"find","terms":["term1"]}',
    '{"mode":"ask"}',
    '{"mode":"clarify","question":"One short specific question"}',
  ].join('\n');

  // The conversation array has the current query appended as its last message by the
  // caller — strip it so we don't duplicate it, then take up to 4 prior turns for context.
  const priorTurns = conversation.slice(0, -1).slice(-4).map((message) => ({
    role: message.role,
    content: normalizeText(message.content).slice(0, 500),
  }));

  const userMessage = priorTurns.length > 0
    ? `${priorTurns.map((turn) => `${turn.role}: ${turn.content}`).join('\n')}\nuser: ${query}`
    : query;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 150,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeoutId);

    if (!response?.ok) return { mode: 'ask' };

    const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = payload.content?.find((item) => item.type === 'text')?.text?.trim() ?? '';
    if (!text) return { mode: 'ask' };

    const candidate = extractJsonObjectCandidate(text) ?? text;
    const parsed = JSON.parse(candidate) as unknown;
    if (isClassifyResult(parsed)) {
      console.log('[transcript search] classifier raw:', text);
      console.log('[transcript search] classifier result:', JSON.stringify(parsed));
      return parsed;
    }
  } catch {
    // Fall through to default.
  }

  console.log('[transcript search] classifier fallback → ask');
  return { mode: 'ask' };
}

function chunkTranscript(record: TranscriptRecord): TranscriptChunk[] {
  const cleaned = record.text.replace(/\r/g, '').trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n{2,}/).map((part) => normalizeText(part)).filter(Boolean);
  const chunks: TranscriptChunk[] = [];
  let current = '';
  let chunkIndex = 0;

  const pushChunk = () => {
    const text = normalizeText(current);
    if (!text) return;
    chunks.push({
      id: `${record.jobId}-${chunkIndex + 1}`,
      jobId: record.jobId,
      filename: record.filename,
      text,
      score: 0,
    });
    chunkIndex += 1;
    current = '';
  };

  for (const paragraph of paragraphs.length ? paragraphs : [cleaned]) {
    if (!current) {
      current = paragraph;
      continue;
    }

    if ((current.length + paragraph.length + 2) > MAX_CHARS_PER_CHUNK) {
      pushChunk();
      current = paragraph;
      continue;
    }

    current = `${current}\n\n${paragraph}`;
  }

  pushChunk();
  return chunks;
}

function scoreChunk(query: string, chunk: TranscriptChunk, conversation: SearchConversationMessage[]): number {
  const queryTerms = uniqueTokens(query);
  const recentConversation = conversation.slice(-MAX_CONVERSATION_TURNS).map((message) => message.content).join(' ');
  const contextTerms = uniqueTokens(recentConversation);
  const haystack = ` ${chunk.text.toLowerCase()} `;
  let score = 0;

  for (const token of queryTerms) {
    if (haystack.includes(` ${token} `)) score += 4;
    else if (haystack.includes(token)) score += 2;
  }

  for (const token of contextTerms.slice(0, 8)) {
    if (haystack.includes(` ${token} `)) score += 1;
  }

  const queryPhrase = normalizeText(query).toLowerCase();
  if (queryPhrase.length >= 12 && haystack.includes(queryPhrase)) score += 8;
  if (detectQuoteIntent(query) && /["']/.test(chunk.text)) score += 2;
  if (detectListIntent(query) && /\b(first|second|third|another|also|example|for example)\b/i.test(chunk.text)) score += 2;
  return score;
}

function pickRelevantChunks(records: TranscriptRecord[], query: string, conversation: SearchConversationMessage[]): TranscriptChunk[] {
  const listIntent = detectListIntent(query);
  const quoteIntent = detectQuoteIntent(query);
  const maxChunksPerTranscript = quoteIntent
    ? Math.min(MAX_CHUNKS_PER_TRANSCRIPT + 4, 10)
    : listIntent ? Math.min(MAX_CHUNKS_PER_TRANSCRIPT + 2, 8) : MAX_CHUNKS_PER_TRANSCRIPT;
  const maxChunksTotal = quoteIntent
    ? Math.min(MAX_CHUNKS_TOTAL + 12, 36)
    : listIntent ? Math.min(MAX_CHUNKS_TOTAL + 8, 32) : MAX_CHUNKS_TOTAL;
  const maxEvidenceChars = quoteIntent
    ? Math.min(MAX_EVIDENCE_CHARS + 18000, 50000)
    : listIntent ? Math.min(MAX_EVIDENCE_CHARS + 8000, 40000) : MAX_EVIDENCE_CHARS;
  const allChunks = records.flatMap((record) => (
    chunkTranscript(record).map((chunk) => ({
      ...chunk,
      score: scoreChunk(query, chunk, conversation),
    }))
  ));

  const byTranscript = new Map<string, TranscriptChunk[]>();
  for (const chunk of allChunks) {
    const existing = byTranscript.get(chunk.jobId) ?? [];
    existing.push(chunk);
    byTranscript.set(chunk.jobId, existing);
  }

  const selected: TranscriptChunk[] = [];
  for (const transcriptChunks of byTranscript.values()) {
    selected.push(...transcriptChunks
      .sort((a, b) => b.score - a.score)
      .slice(0, maxChunksPerTranscript));
  }

  let totalChars = 0;
  return selected
    .sort((a, b) => b.score - a.score)
    .filter((chunk) => {
      if (selected.length > maxChunksTotal && chunk.score <= 0) return false;
      if (totalChars + chunk.text.length > maxEvidenceChars) return false;
      totalChars += chunk.text.length;
      return true;
    })
    .slice(0, maxChunksTotal);
}

function formatAnswer(summary: string | undefined, bullets: string[] | undefined, answer: string | undefined): string {
  const cleanSummary = normalizeText(summary ?? '');
  const cleanBullets = (bullets ?? [])
    .map((bullet) => normalizeText(bullet))
    .filter(Boolean)
    .slice(0, 8);

  if (cleanSummary && cleanBullets.length > 0) {
    return `${cleanSummary}\n\n${cleanBullets.map((bullet) => `- ${bullet}`).join('\n')}`;
  }
  if (cleanSummary) return cleanSummary;
  return normalizeText(answer ?? '');
}

function buildThreadSummary(threadSummary: string | undefined, conversation: SearchConversationMessage[]): string {
  const recent = conversation.slice(-MAX_CONVERSATION_TURNS)
    .map((message) => `${message.role}: ${normalizeText(message.content).slice(0, 220)}`)
    .join('\n');
  return normalizeText([threadSummary ?? '', recent].filter(Boolean).join('\n')).slice(0, 900);
}

function extractJsonObjectCandidate(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseClaudeSearchPayload(text: string): ClaudeSearchPayload {
  const candidates = [
    text.trim(),
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? null,
    extractJsonObjectCandidate(text),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isClaudeSearchPayload(parsed)) return parsed;
    } catch {
      // Try the next extraction strategy.
    }
  }

  throw new TranscriptSearchError('Claude transcript search returned invalid JSON.', 502);
}

async function requestClaudeSearch(input: {
  query: string;
  evidence: TranscriptChunk[];
  conversation: SearchConversationMessage[];
  threadSummary?: string;
  verbatimIntent?: boolean;
}): Promise<ClaudeSearchPayload> {
  const apiKey = process.env.CLAUDE_API_KEY?.trim();
  if (!apiKey) throw new TranscriptSearchError('CLAUDE_API_KEY is not configured.', 503);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const systemLines = [
    'You answer questions about project transcripts using only the supplied evidence excerpts.',
    'Be concise, grounded, and honest when the answer is not supported.',
    'Default answer structure: 1 to 2 sentence summary first, then short bullet-point specifics.',
    'If the user asks for a list, places, instances, examples, or bullets, each bullet should capture one concrete item.',
    'Do not describe the format you are using. Just return the content in the requested structure.',
    'Return strict JSON with this shape:',
    '{"summary":"...","bullets":["..."],"citationIds":["e1"],"threadSummary":"..."}',
    'Never cite an excerpt that was not provided.',
  ];
  if (input.verbatimIntent) {
    systemLines.push('The user wants verbatim transcript text. Your answer MUST include exact quoted passages from the provided excerpts. Do not paraphrase.');
  }
  const system = systemLines.join('\n');

  const evidencePayload = input.evidence.map((chunk, index) => ({
    id: `e${index + 1}`,
    jobId: chunk.jobId,
    filename: chunk.filename,
    excerpt: chunk.text,
  }));

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 2500,
    system,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        question: input.query,
        conversation: input.conversation.slice(-MAX_CONVERSATION_TURNS),
        threadSummary: buildThreadSummary(input.threadSummary, input.conversation),
        evidence: evidencePayload,
      }),
    }],
  };

  const response = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((error) => {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TranscriptSearchError(`Claude transcript search timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`, 504);
    }
    throw error;
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new TranscriptSearchError(`Claude transcript search failed (${response.status}): ${details.slice(0, 240)}`, 502);
  }

  const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  const text = payload.content?.find((item) => item.type === 'text')?.text?.trim() ?? '';
  if (!text) throw new TranscriptSearchError('Claude transcript search returned no text.', 502);

  return parseClaudeSearchPayload(text);
}

function extractContext(text: string, matchStart: number, matchLength: number): string {
  const start = Math.max(0, matchStart - LOCAL_CONTEXT_RADIUS);
  const end = Math.min(text.length, matchStart + matchLength + LOCAL_CONTEXT_RADIUS);
  let excerpt = text.slice(start, end);
  if (start > 0) excerpt = `...${excerpt}`;
  if (end < text.length) excerpt = `${excerpt}...`;
  return normalizeText(excerpt);
}

function phraseSearch(record: TranscriptRecord, phrase: string): LocalMatch[] {
  const haystack = record.text.toLowerCase();
  const needle = phrase.toLowerCase();
  if (!needle) return [];
  const matches: LocalMatch[] = [];
  let pos = haystack.indexOf(needle);
  while (pos !== -1 && matches.length < LOCAL_MAX_MATCHES_PER_TRANSCRIPT) {
    matches.push({
      jobId: record.jobId,
      filename: record.filename,
      excerpt: extractContext(record.text, pos, phrase.length),
      matchIndex: pos,
    });
    pos = haystack.indexOf(needle, pos + 1);
  }
  return matches;
}

function tokenFallbackSearch(record: TranscriptRecord, tokens: string[]): LocalMatch[] {
  if (!tokens.length) return [];
  const haystack = record.text.toLowerCase();

  // Single token — simple position search.
  if (tokens.length === 1) {
    const token = tokens[0]!;
    const matches: LocalMatch[] = [];
    let pos = haystack.indexOf(token);
    while (pos !== -1 && matches.length < LOCAL_MAX_MATCHES_PER_TRANSCRIPT) {
      matches.push({
        jobId: record.jobId,
        filename: record.filename,
        excerpt: extractContext(record.text, pos, token.length),
        matchIndex: pos,
      });
      pos = haystack.indexOf(token, pos + 1);
    }
    return matches;
  }

  // Multiple tokens — find the rarest token to use as anchor, then require ALL
  // tokens to appear within a proximity window around each anchor hit.
  // This prevents a common word (e.g. a speaker's name) from flooding results
  // when the rarer search target doesn't appear in the transcript at all.
  const PROXIMITY = 500;

  let anchorToken = tokens[0]!;
  let anchorCount = Infinity;
  for (const token of tokens) {
    let count = 0;
    let p = haystack.indexOf(token);
    while (p !== -1) { count++; p = haystack.indexOf(token, p + 1); }
    if (count > 0 && count < anchorCount) { anchorCount = count; anchorToken = token; }
  }

  if (anchorCount === Infinity) return []; // Not even the rarest token was found.

  const matches: LocalMatch[] = [];
  let pos = haystack.indexOf(anchorToken);
  while (pos !== -1 && matches.length < LOCAL_MAX_MATCHES_PER_TRANSCRIPT) {
    const winStart = Math.max(0, pos - PROXIMITY);
    const winEnd = Math.min(haystack.length, pos + anchorToken.length + PROXIMITY);
    const window = haystack.slice(winStart, winEnd);

    if (tokens.every((token) => window.includes(token))) {
      matches.push({
        jobId: record.jobId,
        filename: record.filename,
        excerpt: extractContext(record.text, pos, anchorToken.length),
        matchIndex: pos,
      });
    }

    pos = haystack.indexOf(anchorToken, pos + 1);
  }

  return matches;
}

function buildLocalSearchAnswer(matches: LocalMatch[]): string {
  const total = matches.length;
  const distinctJobIds = new Set(matches.map((match) => match.jobId));
  const transcriptCount = distinctJobIds.size;
  const stripExt = (f: string) => f.replace(/\.[^.]+$/, '');

  if (total === 1) {
    return `I found one mention in "${stripExt(matches[0]!.filename)}". Here's the excerpt:`;
  }
  if (transcriptCount === 1) {
    return `I found ${total} mentions in "${stripExt(matches[0]!.filename)}". Here's what came up:`;
  }
  return `I found ${total} mention${total === 1 ? '' : 's'} across ${transcriptCount} transcript${transcriptCount === 1 ? '' : 's'}. Here are the relevant passages:`;
}

function localTextSearch(records: TranscriptRecord[], query: string): TranscriptSearchResponse {
  // Strip wrapping quotes if the user typed a quoted phrase.
  const phrase = /^["'](.+)["']$/.exec(query.trim())?.[1] ?? query;
  const tokens = tokenize(query);
  console.log('[transcript search] local find — phrase:', JSON.stringify(phrase), 'tokens:', JSON.stringify(tokens));

  const allMatches: LocalMatch[] = [];
  for (const record of records) {
    if (allMatches.length >= LOCAL_MAX_MATCHES_TOTAL) break;
    const hits = phraseSearch(record, phrase);
    const recordMatches = hits.length > 0 ? hits : tokenFallbackSearch(record, tokens);
    if (recordMatches.length > 0) {
      console.log(`[transcript search] matched "${record.filename}": ${hits.length} phrase hits, ${recordMatches.length - hits.length} token-fallback hits`);
    }
    allMatches.push(...recordMatches);
  }

  const capped = allMatches.slice(0, LOCAL_MAX_MATCHES_TOTAL);

  if (!capped.length) {
    throw new TranscriptSearchError(
      "I couldn't find that phrase in the selected transcripts. Try rephrasing or switching to Ask mode for a broader search.",
      422,
    );
  }

  const distinctJobIds = [...new Set(capped.map((match) => match.jobId))];

  return {
    answer: buildLocalSearchAnswer(capped),
    sources: capped.map((match) => ({
      jobId: match.jobId,
      filename: match.filename,
      excerpt: match.excerpt,
      isDirectQuote: true,
      matchText: phrase,
    })),
    scope: {
      jobIds: records.map((record) => record.jobId),
      transcriptCount: records.length,
    },
    threadSummary: '',
    searchMode: 'local',
    usage: {
      selectedChunkCount: capped.length,
      selectedTranscriptCount: distinctJobIds.length,
    },
  };
}

export function selectTranscriptScope(projectId: string, requestedJobIds?: string[] | null, mode: 'selected' | 'all' = 'selected'): TranscriptRecord[] {
  const allTranscripts = listProjectTranscripts(projectId);
  if (!allTranscripts.length) throw new TranscriptSearchError('No transcripts are available for this project yet.', 404);

  const requestedSet = new Set((requestedJobIds ?? []).filter(Boolean));
  const scopedEntries = mode === 'all' || requestedSet.size === 0
    ? allTranscripts
    : allTranscripts.filter((entry) => requestedSet.has(entry.jobId));

  if (requestedSet.size > 0 && scopedEntries.length !== requestedSet.size) {
    throw new TranscriptSearchError('One or more selected transcripts could not be found.', 404);
  }

  if (scopedEntries.length > MAX_TRANSCRIPTS_PER_REQUEST) {
    throw new TranscriptSearchError(`Please narrow the search to ${MAX_TRANSCRIPTS_PER_REQUEST} transcripts or fewer.`, 422);
  }

  const records = scopedEntries.map((entry) => ({
    ...entry,
    text: readTranscriptText(projectId, entry.jobId),
  })).filter((entry) => entry.text.trim());

  if (!records.length) throw new TranscriptSearchError('The selected transcripts do not contain searchable text.', 422);
  return records;
}

export async function searchTranscriptContent(input: {
  projectId: string;
  query: string;
  jobIds?: string[] | null;
  mode?: 'selected' | 'all';
  conversation?: SearchConversationMessage[];
  threadSummary?: string;
}): Promise<TranscriptSearchResponse> {
  const query = normalizeText(input.query);
  if (!query) throw new TranscriptSearchError('A search question is required.', 400);

  const records = selectTranscriptScope(input.projectId, input.jobIds, input.mode ?? 'selected');
  const conversation = (input.conversation ?? []).filter((message) => normalizeText(message.content));

  const classification = await classifyQuery(query, conversation);

  console.log('[transcript search] query:', JSON.stringify(query), '→ mode:', classification.mode, classification.mode === 'find' ? `terms: ${JSON.stringify(classification.terms)}` : '');

  if (classification.mode === 'clarify') {
    return {
      answer: '',
      sources: [],
      scope: { jobIds: [], transcriptCount: 0 },
      clarifyQuestion: classification.question,
    };
  }

  if (classification.mode === 'find') {
    return localTextSearch(records, classification.terms.join(' '));
  }

  const evidence = pickRelevantChunks(records, query, conversation);

  if (!evidence.length) {
    throw new TranscriptSearchError('No relevant transcript excerpts were found for that question.', 422);
  }

  const modelResponse = await requestClaudeSearch({
    query,
    evidence,
    conversation,
    threadSummary: input.threadSummary,
    verbatimIntent: detectQuoteIntent(query),
  });

  const evidenceMap = new Map<string, TranscriptChunk>(evidence.map((chunk, index) => [`e${index + 1}`, chunk]));
  const sources = (modelResponse.citationIds ?? [])
    .map((id) => evidenceMap.get(id))
    .filter((value): value is TranscriptChunk => Boolean(value))
    .map((chunk) => ({
      jobId: chunk.jobId,
      filename: chunk.filename,
      excerpt: chunk.text,
    }));

  return {
    answer: formatAnswer(modelResponse.summary, modelResponse.bullets, modelResponse.answer)
      || 'I could not find a grounded answer in the selected transcript excerpts.',
    sources,
    scope: {
      jobIds: records.map((record) => record.jobId),
      transcriptCount: records.length,
    },
    threadSummary: normalizeText(modelResponse.threadSummary ?? buildThreadSummary(input.threadSummary, conversation)).slice(0, 900),
    searchMode: 'ai',
    usage: {
      selectedChunkCount: evidence.length,
      selectedTranscriptCount: records.length,
    },
  };
}

export const transcriptSearchInternals = {
  chunkTranscript,
  scoreChunk,
  pickRelevantChunks,
  detectQuoteIntent,
  detectListIntent,
  formatAnswer,
};
