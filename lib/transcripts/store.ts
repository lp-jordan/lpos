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
    };
  });

  transcripts.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  return transcripts;
}

export function readTranscriptDownload(projectId: string, jobId: string, type: 'txt' | 'json' | 'srt' | 'vtt'): Buffer | null {
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
