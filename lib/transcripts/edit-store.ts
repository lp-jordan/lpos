import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getTranscriptPaths } from './store';
import { writeDerivedTranscriptFiles, writeFileAtomic, type WhisperJson, type WhisperSegment } from './render';

/**
 * Read/write layer for MANUAL transcript edits.
 *
 * Edits patch `transcription[i].text` in the canonical `<jobId>.json` and nothing
 * else — every segment's `timestamps` and `offsets` pass through untouched, so a
 * text edit can never move a caption. `.txt`/`.srt`/`.vtt` are then regenerated
 * from the patched segments (lib/transcripts/render.ts), which is what makes the
 * existing publish flows pick the edit up with no changes of their own.
 *
 * Deliberately NOT supported: splitting, merging, reordering or retiming cues.
 * The Spanish transcript is generated 1:1 index-aligned with English (see
 * transcript-translation.ts), and re-segmenting either side would break that
 * pairing — which is what the editor's side-by-side view and its per-row
 * re-translation both depend on.
 */

const REVISIONS_TO_KEEP = 10;

export interface TranscriptEditMeta {
  jobId?: string;
  filename?: string;
  completedAt?: string;
  assetId?: string;
  lang?: 'en' | 'es';
  /** Bumped on every manual save; the editor's optimistic-concurrency token. */
  revision?: number;
  editedAt?: string;
  /** Cloudflare caption-track sync state for THIS transcript's language. */
  captions?: {
    syncedAt: string | null;
    vttSha1: string | null;
    error: string | null;
  };
  /**
   * Spanish transcripts only: SHA1 of each English segment's text as it stood
   * when this translation was last known to be in sync. A mismatch against the
   * live English transcript is what flags a Spanish row as needing a look.
   */
  enSourceHashes?: string[];
}

export interface TranscriptCue {
  index: number;
  /** `HH:MM:SS,mmm`, straight from the segment — display only, never edited. */
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  text: string;
}

export interface TranscriptDoc {
  jobId: string;
  lang: 'en' | 'es';
  revision: number;
  cues: TranscriptCue[];
  captions: NonNullable<TranscriptEditMeta['captions']>;
  editedAt: string | null;
}

export class TranscriptConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super('This transcript was saved by someone else since you opened it.');
    this.name = 'TranscriptConflictError';
  }
}

export class TranscriptNotFoundError extends Error {
  constructor(jobId: string) {
    super(`No transcript JSON on disk for job ${jobId}.`);
    this.name = 'TranscriptNotFoundError';
  }
}

// ── Meta ─────────────────────────────────────────────────────────────────────

export function readEditMeta(projectId: string, jobId: string): TranscriptEditMeta {
  const { metaPath } = getTranscriptPaths(projectId, jobId);
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TranscriptEditMeta;
  } catch {
    return {};
  }
}

/** Merge-and-write — never clobbers fields written by the transcripter service. */
export function patchEditMeta(projectId: string, jobId: string, patch: Partial<TranscriptEditMeta>): TranscriptEditMeta {
  const { metaPath } = getTranscriptPaths(projectId, jobId);
  const merged: TranscriptEditMeta = { ...readEditMeta(projectId, jobId), ...patch };
  writeFileAtomic(metaPath, JSON.stringify(merged, null, 2));
  return merged;
}

function defaultCaptions(): NonNullable<TranscriptEditMeta['captions']> {
  return { syncedAt: null, vttSha1: null, error: null };
}

// ── Reading ──────────────────────────────────────────────────────────────────

function readWhisperJson(projectId: string, jobId: string): WhisperJson {
  const { jsonPath } = getTranscriptPaths(projectId, jobId);
  if (!fs.existsSync(jsonPath)) throw new TranscriptNotFoundError(jobId);
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as WhisperJson;
  if (!Array.isArray(raw.transcription)) throw new TranscriptNotFoundError(jobId);
  return raw;
}

export function hashCueText(text: string): string {
  return crypto.createHash('sha1').update(text.trim()).digest('hex').slice(0, 16);
}

export function readTranscriptDoc(projectId: string, jobId: string): TranscriptDoc {
  const raw = readWhisperJson(projectId, jobId);
  const meta = readEditMeta(projectId, jobId);

  return {
    jobId,
    lang: meta.lang === 'es' ? 'es' : 'en',
    revision: meta.revision ?? 0,
    editedAt: meta.editedAt ?? null,
    captions: meta.captions ?? defaultCaptions(),
    cues: raw.transcription.map((seg, index) => ({
      index,
      from: seg.timestamps.from,
      to: seg.timestamps.to,
      fromMs: seg.offsets?.from ?? 0,
      toMs: seg.offsets?.to ?? 0,
      text: seg.text.trim(),
    })),
  };
}

/**
 * Indices of Spanish cues whose English source has changed since the Spanish
 * transcript was last in sync — the editor's "English changed" flags.
 *
 * Returns [] (and backfills the baseline) when the Spanish transcript predates
 * hash tracking: with no recorded baseline there is no evidence of drift, and
 * flagging every row would be noise rather than information.
 */
export function computeEnglishDrift(projectId: string, esJobId: string, enJobId: string): number[] {
  let englishTexts: string[];
  try {
    englishTexts = readWhisperJson(projectId, enJobId).transcription.map((seg) => seg.text);
  } catch {
    return [];
  }

  const meta = readEditMeta(projectId, esJobId);
  const baseline = meta.enSourceHashes;

  if (!Array.isArray(baseline) || baseline.length !== englishTexts.length) {
    patchEditMeta(projectId, esJobId, { enSourceHashes: englishTexts.map(hashCueText) });
    return [];
  }

  const drifted: number[] = [];
  englishTexts.forEach((text, index) => {
    if (hashCueText(text) !== baseline[index]) drifted.push(index);
  });
  return drifted;
}

/** Re-baseline the Spanish transcript against current English (clears its flags). */
export function clearEnglishDrift(projectId: string, esJobId: string, enJobId: string, indices?: number[]): void {
  let englishTexts: string[];
  try {
    englishTexts = readWhisperJson(projectId, enJobId).transcription.map((seg) => seg.text);
  } catch {
    return;
  }

  const meta = readEditMeta(projectId, esJobId);
  const baseline = Array.isArray(meta.enSourceHashes) && meta.enSourceHashes.length === englishTexts.length
    ? [...meta.enSourceHashes]
    : englishTexts.map(hashCueText);

  const targets = indices ?? englishTexts.map((_, i) => i);
  for (const index of targets) {
    if (index >= 0 && index < englishTexts.length) baseline[index] = hashCueText(englishTexts[index]);
  }
  patchEditMeta(projectId, esJobId, { enSourceHashes: baseline });
}

// ── Revision snapshots ───────────────────────────────────────────────────────

function revisionsDir(projectId: string, jobId: string): string {
  const { jsonPath } = getTranscriptPaths(projectId, jobId);
  return path.join(path.dirname(jsonPath), '.revisions', jobId);
}

/**
 * Snapshot the pre-edit JSON before overwriting it. This workspace has lost
 * uncommitted work to blunt reverts before; transcripts live outside git, so
 * the only undo they get is the one written here.
 */
function snapshotRevision(projectId: string, jobId: string, raw: WhisperJson): void {
  try {
    const dir = revisionsDir(projectId, jobId);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(raw, null, 2));

    const kept = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const stale of kept.slice(0, Math.max(0, kept.length - REVISIONS_TO_KEEP))) {
      try { fs.unlinkSync(path.join(dir, stale)); } catch { /* already gone */ }
    }
  } catch (err) {
    console.warn(`[transcript-edit] could not snapshot revision for ${jobId}:`, err);
  }
}

// ── Saving ───────────────────────────────────────────────────────────────────

export interface CueEdit {
  index: number;
  text: string;
}

export interface SaveResult {
  revision: number;
  changedIndices: number[];
  vttPath: string;
  cues: TranscriptCue[];
}

/**
 * Apply text-only edits to the canonical JSON and regenerate the derived files.
 * Throws TranscriptConflictError when `baseRevision` is stale, so two open
 * editors can't silently overwrite one another.
 */
export function saveTranscriptCues(
  projectId: string,
  jobId: string,
  edits: readonly CueEdit[],
  baseRevision: number,
): SaveResult {
  const raw = readWhisperJson(projectId, jobId);
  const meta = readEditMeta(projectId, jobId);
  const currentRevision = meta.revision ?? 0;

  if (baseRevision !== currentRevision) throw new TranscriptConflictError(currentRevision);

  const segments = raw.transcription;
  const changedIndices: number[] = [];

  for (const edit of edits) {
    if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= segments.length) {
      throw new Error(`Cue index ${edit.index} is out of range (0–${segments.length - 1}).`);
    }
    const next = edit.text.replace(/\s+/g, ' ').trim();
    if (next === segments[edit.index].text.trim()) continue;
    // Whisper's leading-space convention — preserved so the JSON stays uniform
    // whether a segment came from the model or from a person.
    segments[edit.index] = { ...segments[edit.index], text: ` ${next}` };
    changedIndices.push(edit.index);
  }

  if (changedIndices.length === 0) {
    return {
      revision: currentRevision,
      changedIndices: [],
      vttPath: getTranscriptPaths(projectId, jobId).vttPath,
      cues: readTranscriptDoc(projectId, jobId).cues,
    };
  }

  snapshotRevision(projectId, jobId, readWhisperJson(projectId, jobId));

  const paths = getTranscriptPaths(projectId, jobId);
  const nextJson: WhisperJson = { ...raw, transcription: segments as WhisperSegment[] };
  writeFileAtomic(paths.jsonPath, JSON.stringify(nextJson, null, 2));
  writeDerivedTranscriptFiles(paths, segments);

  const revision = currentRevision + 1;
  patchEditMeta(projectId, jobId, { revision, editedAt: new Date().toISOString() });

  return {
    revision,
    changedIndices,
    vttPath: paths.vttPath,
    cues: readTranscriptDoc(projectId, jobId).cues,
  };
}
