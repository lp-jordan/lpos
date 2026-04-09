import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CloudflareStreamInfo,
  FrameIOInfo,
  LeaderPassInfo,
  MediaAsset,
  TranscriptionInfo,
} from '@/lib/models/media-asset';
import {
  getCanonicalMediaAsset,
  listCanonicalMediaAssets,
  overwriteCanonicalProjections,
  patchCanonicalMediaAsset,
  registerCanonicalMediaAsset,
  removeCanonicalMediaAsset,
} from '@/lib/store/canonical-asset-store';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

export function readRegistry(projectId: string): MediaAsset[] {
  return listCanonicalMediaAssets(projectId);
}

export function writeRegistry(projectId: string, assets: MediaAsset[]): void {
  overwriteCanonicalProjections(projectId, assets);
}

export interface RegisterInput {
  projectId: string;
  name?: string;
  description?: string;
  tags?: string[];
  originalFilename: string;
  filePath: string | null;
  fileSize: number | null;
  mimeType?: string | null;
  duration?: number | null;
  storageType: 'uploaded' | 'registered';
  existingAssetId?: string;
  /** Pre-computed SHA256 hash — avoids a second full-file read during registration. */
  preComputedHash?: string | null;
}

export function registerAsset(input: RegisterInput): MediaAsset {
  return registerCanonicalMediaAsset({
    ...input,
    assetId: randomUUID(),
    mimeType: input.mimeType ?? guessMime(input.originalFilename),
  });
}

export function getAsset(projectId: string, assetId: string): MediaAsset | null {
  return getCanonicalMediaAsset(projectId, assetId);
}

export interface AssetPatch {
  name?: string;
  description?: string;
  tags?: string[];
  filePath?: string | null;
  fileSize?: number | null;
  duration?: number | null;
  transcription?: Partial<TranscriptionInfo>;
  frameio?: Partial<FrameIOInfo>;
  cloudflare?: Partial<CloudflareStreamInfo>;
  leaderpass?: Partial<LeaderPassInfo>;
}

export function patchAsset(projectId: string, assetId: string, patch: AssetPatch): MediaAsset | null {
  return patchCanonicalMediaAsset(projectId, assetId, patch);
}

export function removeAsset(projectId: string, assetId: string): MediaAsset | null {
  return removeCanonicalMediaAsset(projectId, assetId);
}

export function migrateLooseFiles(projectId: string): void {
  const mediaDir = path.join(DATA_DIR, 'projects', projectId, 'media');
  if (!fs.existsSync(mediaDir)) return;

  const existing = readRegistry(projectId);
  const knownPaths = new Set(existing.map((asset) => asset.filePath));
  const videoExts = new Set(['.mp4', '.mov', '.avi', '.mkv', '.mxf', '.webm', '.m4v', '.mts', '.mp3', '.wav', '.aac', '.flac']);

  for (const filename of fs.readdirSync(mediaDir)) {
    if (filename.endsWith('.meta.json') || filename.startsWith('.')) continue;
    if (/^upload-\d+/.test(filename) || /^chunk-upload-/.test(filename)) continue;
    if (!videoExts.has(path.extname(filename).toLowerCase())) continue;

    const fullPath = path.join(mediaDir, filename);
    if (knownPaths.has(fullPath)) continue;

    let originalFilename = filename;
    const metaFile = path.join(mediaDir, filename.replace(/\.[^.]+$/, '') + '.meta.json');
    try {
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { filename?: string };
        if (meta.filename) originalFilename = meta.filename;
      }
    } catch {
      // ignore sidecar issues
    }

    const stat = fs.statSync(fullPath);
    registerAsset({
      projectId,
      originalFilename,
      filePath: fullPath,
      fileSize: stat.size,
      storageType: 'uploaded',
    });
  }
}

function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.mxf': 'application/mxf',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
    '.mts': 'video/mp2t',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
  };
  return map[ext] ?? 'application/octet-stream';
}
