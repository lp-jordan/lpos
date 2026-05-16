import { randomUUID } from 'node:crypto';
import type { PhotoAsset } from '@/lib/models/photo-asset';
import { getPhotoDb } from '@/lib/store/photo-db';

type Row = {
  photo_id: string;
  project_id: string;
  original_filename: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  capture_date: string | null;
  uploaded_at: string;
  updated_at: string;
  edited: number;
};

function rowToAsset(row: Row): PhotoAsset {
  return {
    photoId: row.photo_id,
    projectId: row.project_id,
    originalFilename: row.original_filename,
    filePath: row.file_path,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    captureDate: row.capture_date,
    uploadedAt: row.uploaded_at,
    updatedAt: row.updated_at,
    edited: row.edited === 1,
  };
}

export interface RegisterPhotoInput {
  projectId: string;
  originalFilename: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  captureDate: string | null;
}

export function registerPhoto(input: RegisterPhotoInput): PhotoAsset {
  const photoId = randomUUID();
  const now = new Date().toISOString();
  const db = getPhotoDb();
  db.prepare(`
    INSERT INTO photos (photo_id, project_id, original_filename, file_path, file_size, mime_type, capture_date, uploaded_at, updated_at, edited)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    photoId,
    input.projectId,
    input.originalFilename,
    input.filePath,
    input.fileSize,
    input.mimeType,
    input.captureDate,
    now,
    now,
  );
  return {
    photoId,
    projectId: input.projectId,
    originalFilename: input.originalFilename,
    filePath: input.filePath,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    captureDate: input.captureDate,
    uploadedAt: now,
    updatedAt: now,
    edited: false,
  };
}

export function listPhotos(projectId: string): PhotoAsset[] {
  const rows = getPhotoDb()
    .prepare(`SELECT * FROM photos WHERE project_id = ? ORDER BY uploaded_at DESC`)
    .all(projectId) as Row[];
  return rows.map(rowToAsset);
}

export function getPhoto(projectId: string, photoId: string): PhotoAsset | null {
  const row = getPhotoDb()
    .prepare(`SELECT * FROM photos WHERE project_id = ? AND photo_id = ?`)
    .get(projectId, photoId) as Row | undefined;
  return row ? rowToAsset(row) : null;
}

export function setPhotoEdited(projectId: string, photoId: string, edited: boolean): PhotoAsset | null {
  const now = new Date().toISOString();
  const result = getPhotoDb()
    .prepare(`UPDATE photos SET edited = ?, updated_at = ? WHERE project_id = ? AND photo_id = ?`)
    .run(edited ? 1 : 0, now, projectId, photoId);
  if (result.changes === 0) return null;
  return getPhoto(projectId, photoId);
}

export function setPhotosEdited(projectId: string, photoIds: string[], edited: boolean): number {
  if (photoIds.length === 0) return 0;
  const now = new Date().toISOString();
  const placeholders = photoIds.map(() => '?').join(',');
  const result = getPhotoDb()
    .prepare(`UPDATE photos SET edited = ?, updated_at = ? WHERE project_id = ? AND photo_id IN (${placeholders})`)
    .run(edited ? 1 : 0, now, projectId, ...photoIds);
  return Number(result.changes);
}

export function removePhoto(projectId: string, photoId: string): PhotoAsset | null {
  const photo = getPhoto(projectId, photoId);
  if (!photo) return null;
  getPhotoDb()
    .prepare(`DELETE FROM photos WHERE project_id = ? AND photo_id = ?`)
    .run(projectId, photoId);
  return photo;
}

export function removePhotos(projectId: string, photoIds: string[]): PhotoAsset[] {
  if (photoIds.length === 0) return [];
  const removed: PhotoAsset[] = [];
  for (const id of photoIds) {
    const photo = removePhoto(projectId, id);
    if (photo) removed.push(photo);
  }
  return removed;
}
