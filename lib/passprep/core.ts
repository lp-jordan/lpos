export type AiProvider = 'openai' | 'claude';

export type Settings = {
  audience: string;
  tone: string;
  workbookDepth: 'Light' | 'Standard' | 'Heavy';
  additionalGuidance: string;
  aiProvider?: AiProvider;
};

export type ProjectVideo = {
  id: string;
  fileName: string;
  code?: string;
  title: string;
  rawText: string;
};

export type NormalizedProject = {
  projectName: string;
  videos: ProjectVideo[];
};

export type CourseVideo = {
  videoId: string;
  sourceTitle: string;
  generatedTitle: string;
  generatedDescription: string;
};

export type CourseModule = {
  id: string;
  title: string;
  videos: CourseVideo[];
};

export type CoursePass = {
  id: string;
  title: string;
  categories: CourseModule[];
};

export type WorkbookSectionStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type WorkbookSection = {
  moduleId: string;
  moduleTitle: string;
  sourceVideoIds: string[];
  markdown: string;
  generationStatus: WorkbookSectionStatus;
  errorMessage?: string;
  updatedAt?: string;
};

export type Workbook = {
  sourcePlanApprovalState: 'draft' | 'approved';
  status: 'idle' | 'generating' | 'completed' | 'failed';
  generatedAt: string;
  lastEditedAt: string;
  templateVersion?: string;
  isStale: boolean;
  sections: WorkbookSection[];
};

export type CourseState = {
  projectName: string;
  modules: CourseModule[];
  passes: CoursePass[];
  activePassId: string;
  metadata: {
    approved: boolean;
    settings: Settings;
    generatedAt: string;
  };
  workbook: Workbook | null;
};

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'into', 'about',
  'have', 'will', 'what', 'when', 'where', 'which', 'while', 'how', 'why', 'you',
  'our', 'their', 'them', 'they', 'was', 'are', 'can', 'its', 'not', 'but', 'all',
  'out', 'too', 'use', 'using',
]);

function cleanText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function extractTopicKeywords(video: ProjectVideo): string[] {
  const text = `${video.title} ${video.rawText}`.toLowerCase();
  return text
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

function toCategoryLabel(keyword: string): string {
  return keyword
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function deriveSourceFromVideoName(video: ProjectVideo): string {
  const fileNameMatch = video.fileName.match(/\b\d+[a-z]\b/i);
  if (fileNameMatch) return fileNameMatch[0].toUpperCase();

  const sourceMatch = video.title.match(/\b\d+[a-z]\b/i);
  if (sourceMatch) return sourceMatch[0].toUpperCase();

  return video.fileName || video.id;
}

function takeSentencePreview(input: string, maxLength = 180): string {
  const cleaned = cleanText(input);
  if (!cleaned) return '';
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0] ?? cleaned;
  return firstSentence.slice(0, maxLength).trim();
}

function generateVideoTitle(video: ProjectVideo): string {
  const base = video.title.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return base || `Lesson ${video.id}`;
}

function generateVideoDescription(video: ProjectVideo): string {
  const preview = takeSentencePreview(video.rawText);
  if (!preview) {
    return `Highlights practical takeaways from ${generateVideoTitle(video)} for real-world application.`;
  }
  return preview.length < 40
    ? `${preview}. Connects the idea to a practical leadership moment.`
    : preview;
}

function groupVideosByTopic(videos: ProjectVideo[]): Array<{ title: string; videos: ProjectVideo[] }> {
  const keywordCounts = new Map<string, number>();
  for (const video of videos) {
    const seen = new Set<string>();
    for (const keyword of extractTopicKeywords(video)) {
      if (seen.has(keyword)) continue;
      seen.add(keyword);
      keywordCounts.set(keyword, (keywordCounts.get(keyword) ?? 0) + 1);
    }
  }

  const seeds = [...keywordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Math.min(6, videos.length)))
    .map(([keyword]) => keyword);

  const categories = (seeds.length ? seeds : ['general']).map((seed, index) => ({
    seed,
    title: `${toCategoryLabel(seed)} Focus ${index + 1}`,
    videos: [] as ProjectVideo[],
  }));

  for (const video of videos) {
    const keywords = new Set(extractTopicKeywords(video));
    let bestIndex = 0;
    let bestScore = -1;

    categories.forEach((category, index) => {
      const score = keywords.has(category.seed) ? 1 : 0;
      if (score > bestScore || (score === bestScore && category.videos.length < categories[bestIndex].videos.length)) {
        bestScore = score;
        bestIndex = index;
      }
    });

    categories[bestIndex].videos.push(video);
  }

  return categories.filter((category) => category.videos.length > 0).map(({ title, videos: groupedVideos }) => ({
    title,
    videos: groupedVideos,
  }));
}

export function buildCourseState(project: NormalizedProject, settings: Settings): CourseState {
  const groups = groupVideosByTopic(project.videos);
  const modules: CourseModule[] = groups.map((group, index) => ({
    id: `module-${index + 1}`,
    title: group.title,
    videos: group.videos.map((video) => ({
      videoId: video.id,
      sourceTitle: deriveSourceFromVideoName(video),
      generatedTitle: generateVideoTitle(video),
      generatedDescription: generateVideoDescription(video),
    })),
  }));

  return {
    projectName: project.projectName,
    modules,
    passes: [
      {
        id: 'pass-1',
        title: 'Pass 1',
        categories: modules,
      },
    ],
    activePassId: 'pass-1',
    metadata: {
      approved: false,
      settings,
      generatedAt: new Date().toISOString(),
    },
    workbook: null,
  };
}

export function createWorkbookShell(courseState: CourseState): Workbook {
  const now = new Date().toISOString();
  return {
    sourcePlanApprovalState: courseState.metadata.approved ? 'approved' : 'draft',
    status: 'idle',
    generatedAt: now,
    lastEditedAt: now,
    isStale: false,
    sections: courseState.modules.map((module) => ({
      moduleId: module.id,
      moduleTitle: module.title,
      sourceVideoIds: module.videos.map((video) => video.videoId),
      markdown: '',
      generationStatus: 'pending',
    })),
  };
}

export function inferAiProvider(): AiProvider | undefined {
  if (process.env.CLAUDE_API_KEY) return 'claude';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return undefined;
}
