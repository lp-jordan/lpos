import { recordLlmUsage, type LlmUsageInput } from '@/lib/store/llm-usage-store';

/**
 * Provider-routed LLM transport for platform tile-field generation
 * (see `generate-fields.ts`). Claude is preferred when both keys are set.
 */

export type AiProvider = 'openai' | 'claude';

export class ModelCallError extends Error {}

const OPENAI_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const CLAUDE_URL = process.env.CLAUDE_BASE_URL ?? 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = 120000;

// Usage is still recorded under the 'pass_prep' feature key so existing
// AI-usage history stays in one bucket (the platform step is still "Pass Prep").
const USAGE_FEATURE = 'pass_prep';

export function inferAiProvider(): AiProvider | undefined {
  if (process.env.CLAUDE_API_KEY) return 'claude';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return undefined;
}

async function requestOpenAi(prompt: string, system: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new ModelCallError('OPENAI_API_KEY is not configured.');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: [{ type: 'input_text', text: prompt }] },
      ],
    }),
    signal: controller.signal,
  }).catch((error) => {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ModelCallError(`OpenAI request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  });

  clearTimeout(timeoutId);
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new ModelCallError(`OpenAI request failed (${response.status}): ${details.slice(0, 300)}`);
  }

  const payload = await response.json() as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };

  return payload.output_text
    ?? payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text
    ?? '';
}

async function requestClaude(prompt: string, system: string): Promise<string> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new ModelCallError('CLAUDE_API_KEY is not configured.');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const response = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 6000,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: controller.signal,
  }).catch((error) => {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ModelCallError(`Claude request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  });

  clearTimeout(timeoutId);
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new ModelCallError(`Claude request failed (${response.status}): ${details.slice(0, 300)}`);
  }

  const payload = await response.json() as { content?: Array<{ type?: string; text?: string }>; usage?: LlmUsageInput['usage'] };
  recordLlmUsage({ feature: USAGE_FEATURE, model: CLAUDE_MODEL, usage: payload.usage ?? {} });
  return payload.content?.find((item) => item.type === 'text')?.text ?? '';
}

export async function callModel(prompt: string, provider: AiProvider, system: string): Promise<string> {
  return provider === 'claude' ? requestClaude(prompt, system) : requestOpenAi(prompt, system);
}
