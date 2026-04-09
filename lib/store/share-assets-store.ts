/**
 * Local store for tracking which Frame.io assets belong to each share.
 *
 * The Frame.io V4 API provides no endpoint to list assets in a share —
 * only add (POST .../assets) and remove (DELETE .../assets/{id}) are available.
 * We therefore maintain a local mirror so the UI can display membership.
 *
 * Shape per row: project_id + share_id → file_ids (JSON array of Frame.io file IDs)
 */

import { getCoreDb } from './core-db';

function getFileIds(projectId: string, shareId: string): string[] {
  const row = getCoreDb()
    .prepare('SELECT file_ids FROM share_assets WHERE project_id = ? AND share_id = ?')
    .get(projectId, shareId) as { file_ids: string } | undefined;
  return row ? (JSON.parse(row.file_ids) as string[]) : [];
}

function setFileIds(projectId: string, shareId: string, fileIds: string[]): void {
  getCoreDb().prepare(
    `INSERT INTO share_assets (project_id, share_id, file_ids) VALUES (?, ?, ?)
     ON CONFLICT(project_id, share_id) DO UPDATE SET file_ids = excluded.file_ids`,
  ).run(projectId, shareId, JSON.stringify(fileIds));
}

export function getShareAssets(projectId: string, shareId: string): string[] {
  return getFileIds(projectId, shareId);
}

export function getAllShareAssets(projectId: string): Record<string, string[]> {
  const rows = getCoreDb()
    .prepare('SELECT share_id, file_ids FROM share_assets WHERE project_id = ?')
    .all(projectId) as { share_id: string; file_ids: string }[];
  return Object.fromEntries(rows.map((r) => [r.share_id, JSON.parse(r.file_ids) as string[]]));
}

export function setShareAssets(projectId: string, shareId: string, fileIds: string[]): void {
  setFileIds(projectId, shareId, fileIds);
}

export function addShareAssets(projectId: string, shareId: string, fileIds: string[]): void {
  const existing = new Set(getFileIds(projectId, shareId));
  for (const id of fileIds) existing.add(id);
  setFileIds(projectId, shareId, [...existing]);
}

export function removeShareAsset(projectId: string, shareId: string, fileId: string): void {
  setFileIds(projectId, shareId, getFileIds(projectId, shareId).filter((id) => id !== fileId));
}

export function deleteShareRecord(projectId: string, shareId: string): void {
  getCoreDb().prepare('DELETE FROM share_assets WHERE project_id = ? AND share_id = ?').run(projectId, shareId);
}
