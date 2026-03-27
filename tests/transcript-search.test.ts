import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lpos-transcripts-'));
process.env.LPOS_DATA_DIR = tmpRoot;
process.env.CLAUDE_API_KEY = 'test-claude-key';
const rootUrl = pathToFileURL(`${process.cwd()}${path.sep}`);

function writeTranscript(projectId: string, jobId: string, text: string, filename: string) {
  const projectDir = path.join(tmpRoot, 'projects', projectId);
  const transcriptsDir = path.join(projectDir, 'transcripts');
  const subtitlesDir = path.join(projectDir, 'subtitles');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(subtitlesDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptsDir, `${jobId}.txt`), text, 'utf8');
  fs.writeFileSync(path.join(transcriptsDir, `${jobId}.meta.json`), JSON.stringify({
    filename,
    completedAt: '2026-03-25T10:00:00.000Z',
  }), 'utf8');
}

writeTranscript(
  'project-search',
  'job-alpha',
  'Leadership starts with naming the real problem.\n\nThe strongest teams revisit assumptions before making a decision.\n\n"Small changes compound when repeated every week."',
  'alpha-lesson.mp4',
);
writeTranscript(
  'project-search',
  'job-beta',
  'Communication breaks down when feedback stays vague.\n\nSpecific examples make it easier to coach a team through conflict.',
  'beta-lesson.mp4',
);

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Some sqlite handles can linger briefly in test teardown on Windows.
  }
});

test('relevance scoring prefers matching transcript chunks', async () => {
  const { transcriptSearchInternals, selectTranscriptScope } = await import(new URL('./lib/transcripts/search.ts', rootUrl).href);
  const scoped = selectTranscriptScope('project-search', ['job-alpha'], 'selected');
  const chunks = transcriptSearchInternals.pickRelevantChunks(scoped, 'What does it say about assumptions?', []);

  assert.ok(chunks.length >= 1);
  assert.match(chunks[0]!.text, /assumptions/i);
});

test('searchTranscriptContent returns direct transcript quote without Claude call for quote requests', async () => {
  const { searchTranscriptContent } = await import(new URL('./lib/transcripts/search.ts', rootUrl).href);
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called for quote requests');
  }) as unknown as typeof fetch;

  const result = await searchTranscriptContent({
    projectId: 'project-search',
    query: 'Give me the exact quote about small changes',
    jobIds: ['job-alpha'],
    mode: 'selected',
  });

  global.fetch = originalFetch;

  assert.equal(fetchCalled, false);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]!.isDirectQuote, true);
  assert.match(result.sources[0]!.excerpt, /Small changes compound/i);
});

test('search route returns 400 for blank queries', async () => {
  const { POST } = await import(new URL('./app/api/projects/[projectId]/transcripts/search/route.ts', rootUrl).href);

  const response = await POST(
    {
      url: 'http://localhost/api/projects/project-search/transcripts/search',
      json: async () => ({ query: '   ' }),
    } as never,
    { params: Promise.resolve({ projectId: 'project-search' }) },
  );

  assert.equal(response.status, 400);
  const payload = await response.json() as { error: string };
  assert.match(payload.error, /question is required/i);
});

test('search route returns grounded answer and citations for non-quote questions', async () => {
  const { POST } = await import(new URL('./app/api/projects/[projectId]/transcripts/search/route.ts', rootUrl).href);
  const originalFetch = global.fetch;

  global.fetch = (async () => new Response(JSON.stringify({
    content: [{
      type: 'text',
      text: JSON.stringify({
        summary: 'The transcript says teams should revisit assumptions before making a decision.',
        bullets: [
          'He names revisiting assumptions as part of the decision process.',
          'The point is framed as a practical team behavior rather than a theory.',
        ],
        citationIds: ['e1'],
        threadSummary: 'Discussed assumptions and team decision-making.',
      }),
    }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

  const response = await POST(
    {
      url: 'http://localhost/api/projects/project-search/transcripts/search',
      json: async () => ({
        query: 'What does the transcript say about assumptions?',
        jobIds: ['job-alpha'],
        mode: 'selected',
        conversation: [],
      }),
    } as never,
    { params: Promise.resolve({ projectId: 'project-search' }) },
  );

  global.fetch = originalFetch;

  assert.equal(response.status, 200);
  const payload = await response.json() as {
    answer: string;
    sources: Array<{ excerpt: string }>;
    usage: { selectedChunkCount: number };
  };

  assert.match(payload.answer, /revisit assumptions/i);
  assert.match(payload.answer, /- He names revisiting assumptions/i);
  assert.ok(payload.sources.length >= 1);
  assert.match(payload.sources[0]!.excerpt, /assumptions/i);
  assert.ok(payload.usage.selectedChunkCount >= 1);
});

test('search route tolerates prose-wrapped JSON from Claude', async () => {
  const { POST } = await import(new URL('./app/api/projects/[projectId]/transcripts/search/route.ts', rootUrl).href);
  const originalFetch = global.fetch;

  global.fetch = (async () => new Response(JSON.stringify({
    content: [{
      type: 'text',
      text: [
        'Here is the grounded JSON response you requested.',
        JSON.stringify({
          summary: 'The transcript connects leadership to naming the real problem.',
          bullets: ['It frames leadership as identifying the real issue clearly.'],
          citationIds: ['e1'],
          threadSummary: 'Discussed leadership framing from transcript alpha.',
        }),
      ].join('\n'),
    }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

  const response = await POST(
    {
      url: 'http://localhost/api/projects/project-search/transcripts/search',
      json: async () => ({
        query: 'What does it say about leadership?',
        jobIds: ['job-alpha'],
        mode: 'selected',
        conversation: [{ role: 'user', content: 'Summarize the leadership point.' }],
      }),
    } as never,
    { params: Promise.resolve({ projectId: 'project-search' }) },
  );

  global.fetch = originalFetch;

  assert.equal(response.status, 200);
  const payload = await response.json() as { answer: string; sources: Array<{ excerpt: string }> };
  assert.match(payload.answer, /naming the real problem/i);
  assert.match(payload.answer, /- It frames leadership/i);
  assert.ok(payload.sources.length >= 1);
});

test('formatAnswer combines summary and bullets into readable answer text', async () => {
  const { transcriptSearchInternals } = await import(new URL('./lib/transcripts/search.ts', rootUrl).href);
  const answer = transcriptSearchInternals.formatAnswer(
    'He does this most often when shifting from concept to application.',
    ['In M3, he revisits assumptions.', 'In M5, he contrasts basic and advanced behavior.'],
    '',
  );

  assert.match(answer, /^He does this most often/i);
  assert.match(answer, /- In M3, he revisits assumptions\./i);
  assert.match(answer, /- In M5, he contrasts basic and advanced behavior\./i);
});
