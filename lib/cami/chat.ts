import Anthropic from '@anthropic-ai/sdk';
import { listProjectTranscripts, readTranscriptText, readTranscriptDownload } from '@/lib/transcripts/store';
import { transcriptSearchInternals } from '@/lib/transcripts/search';
import type { TranscriptSearchSource } from '@/lib/transcripts/types';

const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';
const MAX_TOOL_ROUNDS = 5;
const MAX_TRANSCRIPT_CHARS = 40000;
// Hard cap per conversation to prevent runaway cost. Roughly ~$1.50 at Sonnet pricing.
// Override via CLAUDE_MAX_TOKENS_PER_CALL env var.
const MAX_TOKENS_PER_CALL = Number(process.env.CLAUDE_MAX_TOKENS_PER_CALL ?? 100_000);

export interface CamiChatInput {
  projectId: string;
  message: string;
  conversation: { role: 'user' | 'assistant'; content: string }[];
  jobIds: string[];
  scopeMode: 'selected' | 'all';
  threadSummary?: string;
}

export interface CamiChatResult {
  answer: string;
  sources: TranscriptSearchSource[];
  threadSummary: string;
}

const CAMI_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_transcripts',
    description:
      'Semantically search transcript content for relevant information. Best for finding specific facts, statements, or context. Returns the most relevant excerpts.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        jobIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit to specific transcript IDs. Omit to search all transcripts in scope.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_full_transcript',
    description:
      'Get the complete timecoded transcript for a specific video. Use this for tasks requiring the full sequential content: topic segmentation, comprehensive summaries, structural analysis, or understanding the overall flow of a recording.',
    input_schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The transcript ID to retrieve' },
      },
      required: ['jobId'],
    },
  },
];

function buildSystemPrompt(projectId: string, scopedJobIds: string[]): string {
  const allTranscripts = listProjectTranscripts(projectId);
  const scoped = scopedJobIds.length
    ? allTranscripts.filter((t) => scopedJobIds.includes(t.jobId))
    : allTranscripts;

  const transcriptList = scoped.length
    ? scoped.map((t) => `  - "${t.filename}" (id: ${t.jobId})`).join('\n')
    : '  (no transcripts available yet)';

  return [
    "You are Cami, an AI assistant built into LPOS — LeaderPrompt's production operations system.",
    'You help the production team work with video recordings, transcripts, and course content.',
    '',
    'Transcripts available in scope:',
    transcriptList,
    '',
    'Tool usage guidelines:',
    '- Use get_full_transcript when you need complete sequential content: topic segmentation, comprehensive summaries, structure analysis, or understanding the flow of a recording.',
    '- Use search_transcripts to find specific facts, quotes, statements, or context.',
    '- Answer directly from your own knowledge for general questions that do not require transcript content.',
    '',
    'Communication: Be direct and practical. Use bullet points for lists. Avoid unnecessary preamble.',
    `Today's date: ${new Date().toISOString().split('T')[0]}`,
  ].join('\n');
}

function buildThreadSummary(
  prior: { role: string; content: string }[],
  userMessage: string,
  answer: string,
): string {
  const turns = [
    ...prior.slice(-3),
    { role: 'user', content: userMessage },
    { role: 'assistant', content: answer },
  ];
  return turns
    .map((t) => `${t.role}: ${t.content.slice(0, 250)}`)
    .join('\n')
    .slice(0, 900);
}

function toolStatusText(toolName: string, input: unknown): string {
  const inp = input as Record<string, unknown>;
  if (toolName === 'search_transcripts') {
    const q = String(inp.query ?? '').slice(0, 60);
    return `Searching: "${q}"`;
  }
  if (toolName === 'get_full_transcript') {
    return 'Reading full transcript...';
  }
  return 'Working...';
}

function executeGetFullTranscript(
  projectId: string,
  input: unknown,
  sources: TranscriptSearchSource[],
): string {
  const { jobId } = input as { jobId: string };
  const transcripts = listProjectTranscripts(projectId);
  const entry = transcripts.find((t) => t.jobId === jobId);
  if (!entry) {
    return `Transcript not found: ${jobId}. Available IDs: ${transcripts.map((t) => t.jobId).join(', ')}`;
  }

  const type = entry.files.json ? 'timecoded-txt' : 'txt';
  const content = readTranscriptDownload(projectId, jobId, type);
  if (!content) return `Could not read transcript for "${entry.filename}".`;

  const raw = content.toString('utf8');
  const text =
    raw.length > MAX_TRANSCRIPT_CHARS
      ? `${raw.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[Transcript truncated — ${raw.length.toLocaleString()} total characters]`
      : raw;

  if (!sources.some((s) => s.jobId === jobId)) {
    sources.push({
      jobId,
      filename: entry.filename,
      excerpt: raw.slice(0, 300) + (raw.length > 300 ? '...' : ''),
    });
  }

  return `Transcript: "${entry.filename}"\n\n${text}`;
}

function executeSearchTranscripts(
  projectId: string,
  input: unknown,
  scopedJobIds: string[],
  sources: TranscriptSearchSource[],
): string {
  const { query, jobIds: requestedIds } = input as { query: string; jobIds?: string[] };
  const targetIds = requestedIds?.length ? requestedIds : scopedJobIds;
  const allTranscripts = listProjectTranscripts(projectId);
  const relevant = allTranscripts.filter((t) => targetIds.includes(t.jobId));
  const records = relevant
    .map((t) => ({ ...t, text: readTranscriptText(projectId, t.jobId) }))
    .filter((r) => r.text.trim());

  if (!records.length) return 'No transcript content available for search.';

  const chunks = transcriptSearchInternals.pickRelevantChunks(records, query, []);
  if (!chunks.length) return `No relevant content found for: "${query}"`;

  const top = chunks.slice(0, 8);
  for (const chunk of top) {
    if (!sources.some((s) => s.jobId === chunk.jobId && s.excerpt === chunk.text)) {
      sources.push({ jobId: chunk.jobId, filename: chunk.filename, excerpt: chunk.text });
    }
  }

  return top.map((c) => `[${c.filename}]\n${c.text}`).join('\n\n---\n\n');
}

function executeTool(
  projectId: string,
  toolName: string,
  input: unknown,
  scopedJobIds: string[],
  sources: TranscriptSearchSource[],
): string {
  if (toolName === 'get_full_transcript') {
    return executeGetFullTranscript(projectId, input, sources);
  }
  if (toolName === 'search_transcripts') {
    return executeSearchTranscripts(projectId, input, scopedJobIds, sources);
  }
  return `Unknown tool: ${toolName}`;
}

export async function runCamiChat(
  input: CamiChatInput,
  onStatus: (text: string) => void,
): Promise<CamiChatResult> {
  const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

  const allTranscripts = listProjectTranscripts(input.projectId);
  const scopedTranscripts =
    input.scopeMode === 'selected' && input.jobIds.length
      ? allTranscripts.filter((t) => input.jobIds.includes(t.jobId))
      : allTranscripts;
  const scopedJobIds = scopedTranscripts.map((t) => t.jobId);

  const system = buildSystemPrompt(input.projectId, scopedJobIds);

  const messages: Anthropic.MessageParam[] = [
    ...input.conversation.slice(-8).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: input.message },
  ];

  const sources: TranscriptSearchSource[] = [];
  let totalTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const isLastRound = round === MAX_TOOL_ROUNDS - 1;

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system,
      tools: isLastRound ? [] : CAMI_TOOLS,
      messages,
    });

    totalTokens += response.usage.input_tokens + response.usage.output_tokens;
    if (totalTokens > MAX_TOKENS_PER_CALL) {
      console.warn(`[cami] token limit reached: ${totalTokens.toLocaleString()} tokens (limit ${MAX_TOKENS_PER_CALL.toLocaleString()})`);
      return {
        answer: 'This conversation has used a large amount of context. Please start a new thread to continue.',
        sources,
        threadSummary: buildThreadSummary(input.conversation, input.message, ''),
      };
    }

    // Collect text from this response
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const responseText = textBlocks.map((b) => b.text).join('');

    // No tool calls — final answer
    if (response.stop_reason === 'end_turn' || !response.content.some((b) => b.type === 'tool_use')) {
      const answer = responseText || 'I was unable to generate a response.';
      return {
        answer,
        sources,
        threadSummary: buildThreadSummary(input.conversation, input.message, answer),
      };
    }

    // Append assistant turn with all content blocks
    messages.push({ role: 'assistant', content: response.content });

    // Execute tool calls, build tool_result blocks
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      onStatus(toolStatusText(toolUse.name, toolUse.input));
      let result: string;
      try {
        result = executeTool(input.projectId, toolUse.name, toolUse.input, scopedJobIds, sources);
      } catch (error) {
        result = error instanceof Error ? error.message : 'Tool execution failed.';
      }
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Exhausted rounds — shouldn't normally happen
  return {
    answer: 'I could not complete this task within the allowed steps.',
    sources,
    threadSummary: buildThreadSummary(input.conversation, input.message, ''),
  };
}
