import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkbookShell, type AiProvider, type CourseState, type NormalizedProject, type ProjectVideo } from './core';

const ASSET_ROOT = path.join(process.cwd(), 'lib', 'passprep', 'assets');
const WORKBOOK_RULESET_PATH = path.join(ASSET_ROOT, 'workbook-ruleset.md');
const WORKBOOK_TEMPLATE_PATH = path.join(ASSET_ROOT, 'workbook-output-template.md');
const OPENAI_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const CLAUDE_URL = process.env.CLAUDE_BASE_URL ?? 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = 120000;

export class WorkbookGenerationError extends Error {}

export interface LegacyWorkbookSection {
  videoId: string;
  categoryTitle: string;
  title: string;
  content: string;
}

function cleanText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

async function loadWorkbookAssets(): Promise<{ ruleset: string; outputTemplate: string }> {
  const [ruleset, outputTemplate] = await Promise.all([
    fs.readFile(WORKBOOK_RULESET_PATH, 'utf8'),
    fs.readFile(WORKBOOK_TEMPLATE_PATH, 'utf8'),
  ]);
  return { ruleset, outputTemplate };
}

function fallbackWorkbookMarkdown(title: string, description: string, transcript: string): string {
  const preview = cleanText(transcript).slice(0, 700);
  return [
    'Lesson Theme: Practical leadership shifts become visible when they are named and examined honestly.',
    '',
    `Topic Sentence: ${description || `This section explores the core idea behind ${title}.`}`,
    '',
    'Key Takeaways:',
    `1. ${preview ? (preview.split(/(?<=[.!?])\s+/)[0] ?? '').slice(0, 140).trim() : 'Naming the real pattern creates the leverage needed to change it.'} Keep the takeaway specific enough to act on immediately.`,
    '2. Leaders improve faster when they tie insight to a real decision, meeting, or conversation. Reflection matters most when it changes the next move.',
    '3. Pressure reveals existing habits instead of inventing new ones. Honest review turns those habits into usable feedback.',
    '4. Clear language helps teams see what is actually happening. Vague language lets the same problem repeat.',
    '5. Small, specific behavior changes are easier to repeat than abstract intentions. Consistency gives the lesson traction.',
    '',
    'Questions:',
    'Question 1: Where does this pattern show up most clearly in your own leadership right now?',
    'Question 2: Which upcoming conversation or decision would change if you applied this idea deliberately?',
    'Question 3: What would it cost your team if this pattern stayed unnamed for another quarter?',
    '',
    'Challenge: Invite yourself to name one concrete leadership pattern within the next 48 hours. Then test one small change against it.',
  ].join('\n');
}

function parseWorkbookJson(input: string): string {
  const parsed = JSON.parse(input.trim()) as { markdown?: unknown };
  if (typeof parsed.markdown !== 'string' || !parsed.markdown.trim()) {
    throw new WorkbookGenerationError('Workbook model response did not include markdown.');
  }
  return parsed.markdown.trim();
}

async function requestOpenAi(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new WorkbookGenerationError('OPENAI_API_KEY is not configured.');

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
        {
          role: 'system',
          content: [{ type: 'input_text', text: 'You are a JSON-only workbook generator. Never return prose outside JSON.' }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
    }),
    signal: controller.signal,
  }).catch((error) => {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new WorkbookGenerationError(`OpenAI workbook request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  });
  clearTimeout(timeoutId);

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new WorkbookGenerationError(`OpenAI workbook request failed (${response.status}): ${details.slice(0, 300)}`);
  }

  const payload = await response.json() as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };

  return payload.output_text
    ?? payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text
    ?? '';
}

async function requestClaude(prompt: string): Promise<string> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new WorkbookGenerationError('CLAUDE_API_KEY is not configured.');

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
      max_tokens: 2400,
      system: 'You are a JSON-only workbook generator. Never return prose outside JSON.',
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: controller.signal,
  }).catch((error) => {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new WorkbookGenerationError(`Claude workbook request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  });
  clearTimeout(timeoutId);

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new WorkbookGenerationError(`Claude workbook request failed (${response.status}): ${details.slice(0, 300)}`);
  }

  const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  return payload.content?.find((item) => item.type === 'text')?.text ?? '';
}

function buildPrompt(input: {
  title: string;
  categoryTitle: string;
  description: string;
  transcript: string;
  settings: CourseState['metadata']['settings'];
  ruleset: string;
  outputTemplate: string;
}): string {
  return [
    'You are generating one workbook section in markdown.',
    'Return strict JSON with this shape: {"markdown":"..."}',
    '',
    'Workbook ruleset:',
    input.ruleset.trim(),
    '',
    'Workbook output specification:',
    input.outputTemplate.trim(),
    '',
    'Lesson:',
    JSON.stringify({
      title: input.title,
      categoryTitle: input.categoryTitle,
      description: input.description,
      settings: input.settings,
      transcriptExcerpt: input.transcript.slice(0, 2800),
    }, null, 2),
  ].join('\n');
}

function pickVideo(project: NormalizedProject, videoId: string): ProjectVideo | null {
  return project.videos.find((video) => video.id === videoId) ?? null;
}

export async function generateLegacyWorkbookSections(input: {
  courseState: CourseState;
  project: NormalizedProject;
  provider?: AiProvider;
}): Promise<LegacyWorkbookSection[]> {
  const { ruleset, outputTemplate } = await loadWorkbookAssets();
  const provider = input.provider;
  const sections: LegacyWorkbookSection[] = [];

  for (const pass of input.courseState.passes) {
    for (const category of pass.categories) {
      for (const video of category.videos) {
        const sourceVideo = pickVideo(input.project, video.videoId);
        const transcript = sourceVideo?.rawText ?? '';
        let content = fallbackWorkbookMarkdown(video.generatedTitle, video.generatedDescription, transcript);

        if (provider && transcript.trim()) {
          try {
            const prompt = buildPrompt({
              title: video.generatedTitle,
              categoryTitle: category.title,
              description: video.generatedDescription,
              transcript,
              settings: input.courseState.metadata.settings,
              ruleset,
              outputTemplate,
            });
            const outputText = provider === 'claude' ? await requestClaude(prompt) : await requestOpenAi(prompt);
            content = parseWorkbookJson(outputText);
          } catch {
            // Fall back to deterministic content so the UI stays usable.
          }
        }

        sections.push({
          videoId: video.videoId,
          categoryTitle: category.title,
          title: video.generatedTitle,
          content,
        });
      }
    }
  }

  return sections;
}

export function createWorkbookState(courseState: CourseState): CourseState {
  return {
    ...courseState,
    workbook: createWorkbookShell(courseState),
  };
}
