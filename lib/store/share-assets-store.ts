/**
 * Local store for tracking which Frame.io assets belong to each share.
 *
 * The Frame.io V4 API provides no endpoint to list assets in a share —
 * only add (POST .../assets) and remove (DELETE .../assets/{id}) are available.
 * We therefore maintain a local mirror so the UI can display membership.
 *
 * Stored at: data/projects/{projectId}/share-assets.json
 * Shape: { [shareId: string]: string[] }  — Frame.io file IDs
 */

import path from 'node:path';
import fs   from 'node:fs';

function storePath(projectId: string): string {
  return path.join(process.cwd(), 'data', 'projects', projectId, 'share-assets.json');
}

function read(projectId: string): Record<string, string[]> {
  try {
    return JSON.parse(fs.readFileSync(storePath(projectId), 'utf-8')) as Record<string, string[]>;
  } catch {
    return {};
  }
}

function write(projectId: string, data: Record<string, string[]>): void {
  const p = storePath(projectId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

export function getShareAssets(projectId: string, shareId: string): string[] {
  return read(projectId)[shareId] ?? [];
}

/** Return the full shareId → fileIds map for a project. */
export function getAllShareAssets(projectId: string): Record<string, string[]> {
  return read(projectId);
}

export function setShareAssets(projectId: string, shareId: string, fileIds: string[]): void {
  const data = read(projectId);
  data[shareId] = fileIds;
  write(projectId, data);
}

export function addShareAssets(projectId: string, shareId: string, fileIds: string[]): void {
  const data     = read(projectId);
  const existing = new Set(data[shareId] ?? []);
  for (const id of fileIds) existing.add(id);
  data[shareId]  = [...existing];
  write(projectId, data);
}

export function removeShareAsset(projectId: string, shareId: string, fileId: string): void {
  const data    = read(projectId);
  data[shareId] = (data[shareId] ?? []).filter((id) => id !== fileId);
  write(projectId, data);
}

export function deleteShareRecord(projectId: string, shareId: string): void {
  const data = read(projectId);
  delete data[shareId];
  write(projectId, data);
}
