import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lpos-transcript-edit-'));
process.env.LPOS_DATA_DIR = tmpRoot;

const PROJECT = 'proj-1';
const EN_JOB = 'job-en';
const ES_JOB = 'job-es';

interface Seg {
  timestamps: { from: string; to: string };
  offsets: { from: number; to: number };
  text: string;
}

function seg(fromMs: number, toMs: number, text: string): Seg {
  const stamp = (ms: number) => {
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
    const m = String(Math.floor(ms / 60_000) % 60).padStart(2, '0');
    const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
    return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
  };
  return { timestamps: { from: stamp(fromMs), to: stamp(toMs) }, offsets: { from: fromMs, to: toMs }, text: ` ${text}` };
}

function writeTranscript(jobId: string, segments: Seg[], meta: Record<string, unknown>) {
  const transcriptsDir = path.join(tmpRoot, 'projects', PROJECT, 'transcripts');
  const subtitlesDir = path.join(tmpRoot, 'projects', PROJECT, 'subtitles');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(subtitlesDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptsDir, `${jobId}.json`), JSON.stringify({ transcription: segments }, null, 2));
  fs.writeFileSync(path.join(transcriptsDir, `${jobId}.txt`), segments.map((s) => s.text.trim()).join('\n') + '\n');
  fs.writeFileSync(path.join(transcriptsDir, `${jobId}.meta.json`), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(subtitlesDir, `${jobId}.vtt`), 'WEBVTT\n\nstale\n');
  fs.writeFileSync(path.join(subtitlesDir, `${jobId}.srt`), 'stale\n');
}

const EN_SEGMENTS = [
  seg(2400, 6120, 'So when we started, we had maybe four people and a whiteboard.'),
  seg(6120, 10480, 'Nobody was thinking about scale yet.'),
  seg(10480, 14900, 'And I think that is what saved us early on.'),
];

const ES_SEGMENTS = [
  seg(2400, 6120, 'Cuando empezamos, éramos quizás cuatro personas y un pizarrón.'),
  seg(6120, 10480, 'Nadie pensaba todavía en escalar.'),
  seg(10480, 14900, 'Y creo que eso fue lo que nos salvó al principio.'),
];

test('text edits preserve every cue timing and regenerate the derived files', async () => {
  writeTranscript(EN_JOB, EN_SEGMENTS, { assetId: 'asset-1', lang: 'en' });
  const { readTranscriptDoc, saveTranscriptCues } = await import('../lib/transcripts/edit-store');

  const before = readTranscriptDoc(PROJECT, EN_JOB);
  assert.equal(before.revision, 0);
  assert.equal(before.cues.length, 3);
  assert.equal(before.cues[0].text, 'So when we started, we had maybe four people and a whiteboard.');

  const result = saveTranscriptCues(PROJECT, EN_JOB, [{ index: 1, text: 'Nobody was thinking about scale yet — not once.' }], 0);
  assert.equal(result.revision, 1);
  assert.deepEqual(result.changedIndices, [1]);

  const after = readTranscriptDoc(PROJECT, EN_JOB);

  // The point of the whole design: timings are untouched by a text edit.
  for (let i = 0; i < before.cues.length; i += 1) {
    assert.equal(after.cues[i].from, before.cues[i].from, `cue ${i} start moved`);
    assert.equal(after.cues[i].to, before.cues[i].to, `cue ${i} end moved`);
    assert.equal(after.cues[i].fromMs, before.cues[i].fromMs);
    assert.equal(after.cues[i].toMs, before.cues[i].toMs);
  }
  assert.equal(after.cues[1].text, 'Nobody was thinking about scale yet — not once.');
  assert.equal(after.cues[0].text, before.cues[0].text, 'untouched cue was rewritten');

  // Derived files regenerated from the patched JSON, replacing the stale stubs.
  const vtt = fs.readFileSync(path.join(tmpRoot, 'projects', PROJECT, 'subtitles', `${EN_JOB}.vtt`), 'utf8');
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:06\.120 --> 00:00:10\.480/, 'VTT uses dot-millisecond timestamps');
  assert.match(vtt, /Nobody was thinking about scale yet — not once\./);
  assert.ok(!vtt.includes('stale'), 'stale VTT survived the save');

  const srt = fs.readFileSync(path.join(tmpRoot, 'projects', PROJECT, 'subtitles', `${EN_JOB}.srt`), 'utf8');
  assert.match(srt, /00:00:06,120 --> 00:00:10,480/, 'SRT keeps comma milliseconds');

  const txt = fs.readFileSync(path.join(tmpRoot, 'projects', PROJECT, 'transcripts', `${EN_JOB}.txt`), 'utf8');
  assert.match(txt, /Nobody was thinking about scale yet — not once\./);

  // Whisper's leading-space convention survives a human edit.
  const raw = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'projects', PROJECT, 'transcripts', `${EN_JOB}.json`), 'utf8'));
  assert.equal(raw.transcription[1].text, ' Nobody was thinking about scale yet — not once.');
  assert.deepEqual(raw.transcription[1].offsets, { from: 6120, to: 10480 });
});

test('a stale baseRevision is rejected instead of overwriting', async () => {
  const { saveTranscriptCues, TranscriptConflictError } = await import('../lib/transcripts/edit-store');
  assert.throws(
    () => saveTranscriptCues(PROJECT, EN_JOB, [{ index: 0, text: 'clobber' }], 0),
    (err: unknown) => err instanceof TranscriptConflictError && err.currentRevision === 1,
  );
});

test('an out-of-range cue index is refused', async () => {
  const { saveTranscriptCues } = await import('../lib/transcripts/edit-store');
  assert.throws(() => saveTranscriptCues(PROJECT, EN_JOB, [{ index: 99, text: 'nope' }], 1), /out of range/);
});

test('editing English flags only the drifted Spanish rows', async () => {
  const { computeEnglishDrift, clearEnglishDrift, readTranscriptDoc } = await import('../lib/transcripts/edit-store');
  const { hashCueText } = await import('../lib/transcripts/edit-store');

  // Spanish baselined against the ORIGINAL English text.
  writeTranscript(ES_JOB, ES_SEGMENTS, {
    assetId: 'asset-1',
    lang: 'es',
    enSourceHashes: EN_SEGMENTS.map((s) => hashCueText(s.text)),
  });

  // Cue 1 was edited in the previous test, so exactly cue 1 has drifted.
  assert.deepEqual(computeEnglishDrift(PROJECT, ES_JOB, EN_JOB), [1]);

  // Re-baselining that one row clears its flag and leaves the others alone.
  clearEnglishDrift(PROJECT, ES_JOB, EN_JOB, [1]);
  assert.deepEqual(computeEnglishDrift(PROJECT, ES_JOB, EN_JOB), []);

  // Spanish text itself was never touched by any of the English work.
  assert.equal(readTranscriptDoc(PROJECT, ES_JOB).cues[1].text, 'Nadie pensaba todavía en escalar.');
});

test('a Spanish transcript with no recorded baseline reports no drift, and backfills one', async () => {
  const { computeEnglishDrift, readEditMeta } = await import('../lib/transcripts/edit-store');
  writeTranscript('job-es-legacy', ES_SEGMENTS, { assetId: 'asset-1', lang: 'es' });

  assert.deepEqual(computeEnglishDrift(PROJECT, 'job-es-legacy', EN_JOB), [], 'legacy transcript should not flag every row');
  const meta = readEditMeta(PROJECT, 'job-es-legacy');
  assert.equal(meta.enSourceHashes?.length, 3, 'baseline was not backfilled');
});

test('every save keeps a recoverable snapshot of the previous version', async () => {
  const { saveTranscriptCues } = await import('../lib/transcripts/edit-store');
  saveTranscriptCues(PROJECT, EN_JOB, [{ index: 2, text: 'And that is what saved us.' }], 1);

  const revDir = path.join(tmpRoot, 'projects', PROJECT, 'transcripts', '.revisions', EN_JOB);
  const snapshots = fs.readdirSync(revDir).filter((f) => f.endsWith('.json'));
  assert.ok(snapshots.length >= 1, 'no revision snapshot written');

  const restored = JSON.parse(fs.readFileSync(path.join(revDir, snapshots.sort().at(-1)!), 'utf8'));
  assert.equal(restored.transcription[2].text.trim(), 'And I think that is what saved us early on.');
});
