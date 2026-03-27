import { NextRequest, NextResponse } from 'next/server';
import { buildFallbackCoursePlan, generateCoursePlan } from '@/lib/passprep/generate-plan';
import { inferAiProvider, type CourseState, type NormalizedProject, type Settings } from '@/lib/passprep/core';
import { generateLegacyWorkbookSections } from '@/lib/passprep/workbook';
import { readTranscriptMeta, readTranscriptText } from '@/lib/transcripts/store';

type Params = { params: Promise<{ projectId: string }> };

type PPVideo = {
  videoId: string;
  sourceCode: string;
  generatedTitle: string;
  generatedDescription: string;
};

type PPCategory = {
  id: string;
  title: string;
  videos: PPVideo[];
};

type PPPass = {
  id: string;
  title: string;
  categories: PPCategory[];
};

type WorkbookSection = {
  videoId: string;
  categoryTitle: string;
  title: string;
  content: string;
};

function toSettings(input: { audience?: string; tone?: string; additionalGuidance?: string }): Settings {
  return {
    audience: input.audience?.trim() ?? '',
    tone: input.tone?.trim() ?? '',
    additionalGuidance: input.additionalGuidance?.trim() ?? '',
    workbookDepth: 'Standard',
    aiProvider: inferAiProvider(),
  };
}

function stripExtension(input: string): string {
  return input.replace(/\.[^.]+$/, '').trim();
}

function buildNormalizedProject(projectId: string, videoEntries: Array<{ jobId: string; filename: string; transcript: string }>): NormalizedProject {
  return {
    projectName: `Project ${projectId}`,
    videos: videoEntries.map((entry) => ({
      id: entry.jobId,
      fileName: entry.filename,
      code: entry.filename.match(/\b\d+[a-z]\b/i)?.[0]?.toUpperCase(),
      title: stripExtension(entry.filename) || entry.jobId,
      rawText: entry.transcript,
    })),
  };
}

function toLegacyPasses(courseState: CourseState): PPPass[] {
  return courseState.passes.map((pass) => ({
    id: pass.id,
    title: pass.title,
    categories: pass.categories.map((category) => ({
      id: category.id,
      title: category.title,
      videos: category.videos.map((video) => ({
        videoId: video.videoId,
        sourceCode: video.sourceTitle,
        generatedTitle: video.generatedTitle,
        generatedDescription: video.generatedDescription,
      })),
    })),
  }));
}

function fromLegacyPasses(projectName: string, passes: PPPass[], settings: Settings): CourseState {
  const convertedPasses = passes.map((pass) => ({
    id: pass.id,
    title: pass.title,
    categories: pass.categories.map((category) => ({
      id: category.id,
      title: category.title,
      videos: category.videos.map((video) => ({
        videoId: video.videoId,
        sourceTitle: video.sourceCode,
        generatedTitle: video.generatedTitle,
        generatedDescription: video.generatedDescription,
      })),
    })),
  }));

  return {
    projectName,
    modules: convertedPasses.flatMap((pass) => pass.categories),
    passes: convertedPasses,
    activePassId: convertedPasses[0]?.id ?? 'pass-1',
    metadata: {
      approved: false,
      settings,
      generatedAt: new Date().toISOString(),
    },
    workbook: null,
  };
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { projectId } = await params;
    const body = await req.json() as {
      jobIds: string[];
      settings: { audience: string; tone: string; additionalGuidance: string };
    };

    const videoEntries = await Promise.all(
      body.jobIds.map(async (jobId) => {
        const [transcript, meta] = await Promise.all([
          Promise.resolve(readTranscriptText(projectId, jobId)),
          Promise.resolve(readTranscriptMeta(projectId, jobId)),
        ]);
        return {
          jobId,
          filename: meta?.filename ?? jobId,
          transcript,
        };
      }),
    );

    const normalizedProject = buildNormalizedProject(projectId, videoEntries);
    const normalizedSettings = toSettings(body.settings);
    const hasTranscriptText = normalizedProject.videos.some((video) => video.rawText.trim());

    const courseState = hasTranscriptText && normalizedSettings.aiProvider
      ? await generateCoursePlan({
          project: normalizedProject,
          settings: normalizedSettings,
          provider: normalizedSettings.aiProvider,
        }).catch(() => buildFallbackCoursePlan(normalizedProject, normalizedSettings))
      : buildFallbackCoursePlan(normalizedProject, normalizedSettings);

    return NextResponse.json({ passes: toLegacyPasses(courseState) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[passPrep POST]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  try {
    const { projectId } = await params;
    const body = await req.json() as {
      passes: PPPass[];
      settings: { audience: string; tone: string; additionalGuidance: string };
      jobIds: string[];
    };

    const videoEntries = await Promise.all(
      body.jobIds.map(async (jobId) => {
        const [transcript, meta] = await Promise.all([
          Promise.resolve(readTranscriptText(projectId, jobId)),
          Promise.resolve(readTranscriptMeta(projectId, jobId)),
        ]);
        return {
          jobId,
          filename: meta?.filename ?? jobId,
          transcript,
        };
      }),
    );

    const normalizedProject = buildNormalizedProject(projectId, videoEntries);
    const normalizedSettings = toSettings(body.settings);
    const courseState = fromLegacyPasses(normalizedProject.projectName, body.passes, normalizedSettings);

    const sections = await generateLegacyWorkbookSections({
      courseState,
      project: normalizedProject,
      provider: normalizedSettings.aiProvider,
    }) as WorkbookSection[];

    return NextResponse.json({ sections });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[passPrep PUT]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
