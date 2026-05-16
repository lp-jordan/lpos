import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import exifr from 'exifr';
import { resolveProjectPhotosStorageDir } from '@/lib/services/storage-volume-service';

const THUMB_DIR_NAME = '.thumbs';
const THUMB_MAX_DIMENSION = 480;
const PREVIEW_DIR_NAME = '.previews';
const PREVIEW_MAX_DIMENSION = 2400;

// Raw formats where sharp cannot decode pixels; we extract the camera-embedded JPEG preview instead.
const EMBEDDED_PREVIEW_EXTS = new Set(['.arw']);

function isEmbeddedPreviewFormat(filePath: string): boolean {
  return EMBEDDED_PREVIEW_EXTS.has(path.extname(filePath).toLowerCase());
}

export function photoFilePath(projectId: string, photoId: string, ext: string): string {
  return path.join(resolveProjectPhotosStorageDir(projectId), `${photoId}${ext.toLowerCase()}`);
}

export function photoThumbPath(projectId: string, photoId: string): string {
  return path.join(resolveProjectPhotosStorageDir(projectId), THUMB_DIR_NAME, `${photoId}.jpg`);
}

export function photoPreviewPath(projectId: string, photoId: string): string {
  return path.join(resolveProjectPhotosStorageDir(projectId), PREVIEW_DIR_NAME, `${photoId}.jpg`);
}

function exifDateToIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    const m = value.match(/(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * Extracts EXIF capture date as ISO 8601. Reads DateTimeOriginal first, then DateTime as fallback.
 * For raw formats sharp can't decode (e.g. ARW), routes through exifr. Returns null on any failure.
 */
export async function extractCaptureDate(filePath: string): Promise<string | null> {
  try {
    if (isEmbeddedPreviewFormat(filePath)) {
      const tags = await exifr.parse(filePath, { pick: ['DateTimeOriginal', 'CreateDate', 'DateTime', 'ModifyDate'] }) as
        | { DateTimeOriginal?: unknown; CreateDate?: unknown; DateTime?: unknown; ModifyDate?: unknown }
        | undefined;
      if (!tags) return null;
      return exifDateToIso(tags.DateTimeOriginal)
        ?? exifDateToIso(tags.CreateDate)
        ?? exifDateToIso(tags.DateTime)
        ?? exifDateToIso(tags.ModifyDate);
    }

    const metadata = await sharp(filePath).metadata();
    const exif = metadata.exif;
    if (!exif) return null;

    const exifString = exif.toString('binary');
    const match = exifString.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!match) return null;

    const [, year, month, day, hour, minute, second] = match;
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  } catch {
    return null;
  }
}

/**
 * Generates (or returns cached) thumbnail for a photo. Thumbs are JPEG, max 480px on long edge,
 * cached on disk at `<photosDir>/.thumbs/<photoId>.jpg`. Returns the absolute thumb path.
 * For raw formats sharp can't decode (e.g. ARW), the camera-embedded JPEG preview is extracted via
 * exifr first, then resized by sharp. Throws when no usable image can be produced.
 */
export async function ensureThumbnail(projectId: string, photoId: string, sourceFilePath: string): Promise<string> {
  const thumbPath = photoThumbPath(projectId, photoId);
  if (fs.existsSync(thumbPath)) return thumbPath;

  fs.mkdirSync(path.dirname(thumbPath), { recursive: true });

  const input: string | Buffer = isEmbeddedPreviewFormat(sourceFilePath)
    ? await loadEmbeddedPreviewBuffer(sourceFilePath)
    : sourceFilePath;

  await sharp(input, { failOn: 'none' })
    .rotate()
    .resize({ width: THUMB_MAX_DIMENSION, height: THUMB_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, progressive: true })
    .toFile(thumbPath);

  return thumbPath;
}

/**
 * Generates (or returns cached) high-resolution preview JPEG (max 2400 px long edge, q=85),
 * cached on disk at `<photosDir>/.previews/<photoId>.jpg`. Used by the preview-modal endpoint.
 * Same ARW/embedded-preview branching as `ensureThumbnail`. Throws if no usable image can be produced.
 */
export async function ensurePreview(projectId: string, photoId: string, sourceFilePath: string): Promise<string> {
  const previewPath = photoPreviewPath(projectId, photoId);
  if (fs.existsSync(previewPath)) return previewPath;

  fs.mkdirSync(path.dirname(previewPath), { recursive: true });

  const input: string | Buffer = isEmbeddedPreviewFormat(sourceFilePath)
    ? await loadEmbeddedPreviewBuffer(sourceFilePath)
    : sourceFilePath;

  await sharp(input, { failOn: 'none' })
    .rotate()
    .resize({ width: PREVIEW_MAX_DIMENSION, height: PREVIEW_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, progressive: true })
    .toFile(previewPath);

  return previewPath;
}

async function loadEmbeddedPreviewBuffer(filePath: string): Promise<Buffer> {
  // exifr.thumbnail returns the EXIF IFD1 thumbnail (typically 160-1616 px depending on camera).
  // For Sony ARW this is a small camera-rendered JPEG — adequate for our 480 px target.
  const buf = await exifr.thumbnail(filePath);
  if (!buf) throw new Error(`No embedded preview found in ${path.basename(filePath)}`);
  return Buffer.from(buf);
}

export function deletePhotoFiles(projectId: string, photoId: string, sourceFilePath: string): void {
  try { if (fs.existsSync(sourceFilePath)) fs.unlinkSync(sourceFilePath); } catch { /* ignore */ }
  try {
    const thumb = photoThumbPath(projectId, photoId);
    if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
  } catch { /* ignore */ }
  try {
    const preview = photoPreviewPath(projectId, photoId);
    if (fs.existsSync(preview)) fs.unlinkSync(preview);
  } catch { /* ignore */ }
}
