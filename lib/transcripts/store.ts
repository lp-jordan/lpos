import fs from 'node:fs';
import path from 'node:path';
import { readRegistry } from '@/lib/store/media-registry';
import type { TranscriptEntry } from './types';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const UUID_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[^.]+$/i;

interface TranscriptMeta {
  filename?: string;
  completedAt?: string;
  assetId?: string;
  lang?: 'en' | 'es';
}

function getProjectRoot(projectId: string): string {
  return path.join(DATA_DIR, 'projects', projectId);
}

function getTranscriptsDir(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'transcripts');
}

function getSubtitlesDir(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'subtitles');
}

function getAssetNameMap(projectId: string): Map<string, string> {
  const assetNameMap = new Map<string, string>();
  try {
    const assets = readRegistry(projectId);
    for (const asset of assets) assetNameMap.set(asset.assetId, asset.originalFilename ?? asset.name);
  } catch {
    // Ignore missing registry.
  }
  return assetNameMap;
}

export function getTranscriptPaths(projectId: string, jobId: string): {
  txtPath: string;
  jsonPath: string;
  srtPath: string;
  vttPath: string;
  metaPath: string;
} {
  const transcriptsDir = getTranscriptsDir(projectId);
  const subtitlesDir = getSubtitlesDir(projectId);
  return {
    txtPath: path.join(transcriptsDir, `${jobId}.txt`),
    jsonPath: path.join(transcriptsDir, `${jobId}.json`),
    srtPath: path.join(subtitlesDir, `${jobId}.srt`),
    vttPath: path.join(subtitlesDir, `${jobId}.vtt`),
    metaPath: path.join(transcriptsDir, `${jobId}.meta.json`),
  };
}

export function readTranscriptMeta(projectId: string, jobId: string): TranscriptMeta | null {
  const { metaPath } = getTranscriptPaths(projectId, jobId);
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TranscriptMeta;
  } catch {
    return null;
  }
}

export function readTranscriptText(projectId: string, jobId: string): string {
  const { txtPath } = getTranscriptPaths(projectId, jobId);
  try {
    return fs.readFileSync(txtPath, 'utf8');
  } catch {
    return '';
  }
}

function buildTimecodedText(projectId: string, jobId: string): string {
  const { jsonPath } = getTranscriptPaths(projectId, jobId);
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
      transcription?: Array<{ timestamps: { from: string }; text: string }>;
    };
    if (!Array.isArray(raw.transcription)) return '';
    return raw.transcription
      .map((seg) => `[${seg.timestamps.from.substring(0, 8)}] ${seg.text.trim()}`)
      .join('\n');
  } catch {
    return '';
  }
}

export function listProjectTranscripts(projectId: string): TranscriptEntry[] {
  const transcriptsDir = getTranscriptsDir(projectId);
  const subtitlesDir = getSubtitlesDir(projectId);
  if (!fs.existsSync(transcriptsDir)) return [];

  const assetNameMap = getAssetNameMap(projectId);
  const txtFiles = fs.readdirSync(transcriptsDir)
    .filter((file) => file.endsWith('.txt') && !file.endsWith('.meta.json'));

  const transcripts = txtFiles.map((txtName) => {
    const jobId = path.basename(txtName, '.txt');
    const { txtPath, jsonPath, srtPath, vttPath } = getTranscriptPaths(projectId, jobId);
    const stat = fs.statSync(txtPath);
    const meta = readTranscriptMeta(projectId, jobId);

    let filename = meta?.filename ?? jobId;
    if (UUID_FILE_RE.test(filename) && meta?.assetId) {
      const resolved = assetNameMap.get(meta.assetId);
      if (resolved) filename = resolved;
    }

    return {
      jobId,
      filename,
      completedAt: meta?.completedAt ?? stat.mtime.toISOString(),
      txtSize: stat.size,
      files: {
        txt: true,
        json: fs.existsSync(jsonPath),
        srt: fs.existsSync(srtPath),
        vtt: fs.existsSync(vttPath),
      },
      ...(meta?.assetId ? { assetId: meta.assetId } : {}),
      lang: (meta?.lang === 'es' ? 'es' : 'en') as 'en' | 'es',
    };
  });

  transcripts.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  return transcripts;
}

export function deleteTranscriptsByAsset(projectId: string, assetId: string): number {
  const transcriptsDir = getTranscriptsDir(projectId);
  const subtitlesDir   = getSubtitlesDir(projectId);
  if (!fs.existsSync(transcriptsDir)) return 0;

  let deleted = 0;
  const metaFiles = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.meta.json'));

  for (const metaFile of metaFiles) {
    const jobId = path.basename(metaFile, '.meta.json');
    const meta  = readTranscriptMeta(projectId, jobId);
    if (meta?.assetId !== assetId) continue;

    for (const name of [`${jobId}.txt`, `${jobId}.json`, `${jobId}.words.json`, `${jobId}.meta.json`]) {
      try { fs.unlinkSync(path.join(transcriptsDir, name)); } catch { /* already gone */ }
    }
    for (const name of [`${jobId}.srt`, `${jobId}.vtt`]) {
      try { fs.unlinkSync(path.join(subtitlesDir, name)); } catch { /* already gone */ }
    }
    deleted++;
  }

  return deleted;
}

/**
 * Resolve a transcript by the asset it was made from (the load-bearing link for
 * Pass Prep — verified: every transcript `meta.json` carries `assetId`). Picks
 * the most recently completed transcript when several exist for one asset.
 * Returns null when there's no transcript or the text is empty (not ready).
 */
export function getTranscriptTextByAsset(projectId: string, assetId: string): { jobId: string; text: string } | null {
  const transcriptsDir = getTranscriptsDir(projectId);
  if (!fs.existsSync(transcriptsDir)) return null;

  let best: { jobId: string; completedAt: string } | null = null;
  for (const metaFile of fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.meta.json'))) {
    const jobId = path.basename(metaFile, '.meta.json');
    const meta = readTranscriptMeta(projectId, jobId);
    if (meta?.assetId !== assetId) continue;
    const completedAt = meta?.completedAt ?? '';
    if (!best || completedAt > best.completedAt) best = { jobId, completedAt };
  }
  if (!best) return null;

  const text = readTranscriptText(projectId, best.jobId);
  if (!text.trim()) return null;
  return { jobId: best.jobId, text };
}

/** Cheap readiness check for the Pass Prep `no_transcript` flag. */
export function hasReadyTranscriptForAsset(projectId: string, assetId: string): boolean {
  return getTranscriptTextByAsset(projectId, assetId) !== null;
}

export function resolveTranscriptDisplayName(projectId: string, jobId: string): string {
  const meta = readTranscriptMeta(projectId, jobId);
  let filename = meta?.filename ?? jobId;
  if (UUID_FILE_RE.test(filename) && meta?.assetId) {
    const resolved = getAssetNameMap(projectId).get(meta.assetId);
    if (resolved) filename = resolved;
  }
  return filename;
}

export function readTranscriptDownload(
  projectId: string,
  jobId: string,
  type: 'txt' | 'json' | 'srt' | 'vtt' | 'timecoded-txt',
): Buffer | null {
  if (type === 'timecoded-txt') {
    const content = buildTimecodedText(projectId, jobId);
    return content ? Buffer.from(content, 'utf8') : null;
  }

  const paths = getTranscriptPaths(projectId, jobId);
  const filePath = (
    type === 'txt' ? paths.txtPath
      : type === 'json' ? paths.jsonPath
      : type === 'srt' ? paths.srtPath
      : paths.vttPath
  );

  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}
