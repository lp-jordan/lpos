import fs from 'node:fs/promises';
import path from 'node:path';
import { buildCourseState, type AiProvider, type CourseModule, type CourseState, type NormalizedProject, type Settings } from './core';

const ASSET_ROOT = path.join(process.cwd(), 'lib', 'passprep', 'assets');
const HOUSE_STYLE_PATH = path.join(ASSET_ROOT, 'house-style.md');
const OPENAI_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const CLAUDE_URL = process.env.CLAUDE_BASE_URL ?? 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = 120000;

export class GeneratePlanError extends Error {}

function compactProject(project: NormalizedProject) {
  return {
    projectName: project.projectName,
    videos: project.videos.map((video) => ({
      id: video.id,
      fileName: video.fileName,
      code: video.code,
      title: video.title,
      transcriptExcerpt: video.rawText.slice(0, 900),
    })),
  };
}

async function loadHouseStyle(): Promise<string> {
  return fs.readFile(HOUSE_STYLE_PATH, 'utf8');
}

function buildPrompt(project: NormalizedProject, settings: Settings, houseStyle: string): string {
  return [
    'You are generating a course plan from transcript-backed lesson sources.',
    '',
    'House style:',
    houseStyle.trim(),
    '',
    'Constraints:',
    '- Group videos into 2 to 6 coherent categories.',
    '- Every video must appear exactly once.',
    '- Keep titles specific and useful.',
    '- Keep descriptions practical and grounded in transcript content.',
    '',
    'Settings:',
    JSON.stringify(settings, null, 2),
    '',
    'Project bundle:',
    JSON.stringify(compactProject(project), null, 2),
    '',
    'Return JSON only with this exact shape:',
    JSON.stringify({
      modules: [
        {
          id: 'module-1',
          title: 'Category title',
          videos: [
            {
              videoId: 'source-video-id',
              generatedTitle: 'Lesson title',
              generatedDescription: 'Transcript-grounded description',
            },
          ],
        },
      ],
    }, null, 2),
  ].join('\n');
}

function normalizeOutput(project: NormalizedProject, settings: Settings, modules: CourseModule[]): CourseState {
  return {
    projectName: project.projectName,
    modules,
    passes: [{ id: 'pass-1', title: 'Pass 1', categories: modules }],
    activePassId: 'pass-1',
    metadata: {
      approved: false,
      settings,
      generatedAt: new Date().toISOString(),
    },
    workbook: null,
  };
}

function parseModelJson(input: string): unknown {
  try {
    return JSON.parse(input.trim());
  } catch {
    const fenced = input.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
  }
  throw new GeneratePlanError('Model returned invalid JSON.');
}

function validateModules(parsed: unknown, project: NormalizedProject): CourseModule[] {
  const record = parsed as { modules?: Array<Record<string, unknown>> };
  if (!Array.isArray(record.modules) || record.modules.length === 0) {
    throw new GeneratePlanError('Model output did not include modules.');
  }

  const allowedIds = new Set(project.videos.map((video) => video.id));
  const seen = new Set<string>();

  return record.modules.map((module, moduleIndex) => {
    const title = typeof module.title === 'string' && module.title.trim() ? module.title.trim() : `Module ${moduleIndex + 1}`;
    const rawVideos = Array.isArray(module.videos) ? module.videos : [];
    const videos = rawVideos
      .map((video) => {
        const source = video as Record<string, unknown>;
        const videoId = typeof source.videoId === 'string' ? source.videoId : '';
        if (!videoId || !allowedIds.has(videoId) || seen.has(videoId)) return null;
        seen.add(videoId);
        const projectVideo = project.videos.find((item) => item.id === videoId);
        return {
          videoId,
          sourceTitle: projectVideo?.code ?? projectVideo?.fileName ?? videoId,
          generatedTitle: typeof source.generatedTitle === 'string' && source.generatedTitle.trim()
            ? source.generatedTitle.trim()
            : projectVideo?.title ?? videoId,
          generatedDescription: typeof source.generatedDescription === 'string' && source.generatedDescription.trim()
            ? source.generatedDescription.trim()
            : (projectVideo?.rawText.slice(0, 160).trim() || `Highlights ${projectVideo?.title ?? videoId}.`),
        };
      })
      .filter((value): value is CourseModule['videos'][number] => Boolean(value));

    return {
      id: typeof module.id === 'string' && module.id.trim() ? module.id.trim() : `module-${moduleIndex + 1}`,
      title,
      videos,
    };
  }).filter((module) => module.videos.length > 0);
}

async function requestOpenAi(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new GeneratePlanError('OPENAI_API_KEY is not configured.');

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
          content: [{ type: 'input_text', text: 'You are a JSON-only course plan generator. Never return prose.' }],
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
      throw new GeneratePlanError(`OpenAI request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  });

  clearTimeout(timeoutId);
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new GeneratePlanError(`OpenAI request failed (${response.status}): ${details.slice(0, 300)}`);
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
  if (!apiKey) throw new GeneratePlanError('CLAUDE_API_KEY is not configured.');

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
      system: 'You are a JSON-only course plan generator. Never return prose.',
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: controller.signal,
  }).catch((error) => {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GeneratePlanError(`Claude request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  });

  clearTimeout(timeoutId);
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new GeneratePlanError(`Claude request failed (${response.status}): ${details.slice(0, 300)}`);
  }

  const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  return payload.content?.find((item) => item.type === 'text')?.text ?? '';
}

export async function generateCoursePlan(input: {
  project: NormalizedProject;
  settings: Settings;
  provider: AiProvider;
}): Promise<CourseState> {
  const houseStyle = await loadHouseStyle();
  const prompt = buildPrompt(input.project, input.settings, houseStyle);
  const outputText = input.provider === 'claude'
    ? await requestClaude(prompt)
    : await requestOpenAi(prompt);
  const parsed = parseModelJson(outputText);
  const modules = validateModules(parsed, input.project);

  if (!modules.length) {
    throw new GeneratePlanError('Model output did not produce any valid modules.');
  }

  return normalizeOutput(input.project, input.settings, modules);
}

export function buildFallbackCoursePlan(project: NormalizedProject, settings: Settings): CourseState {
  return buildCourseState(project, settings);
}
