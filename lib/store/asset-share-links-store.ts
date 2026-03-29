/**
 * Tracks share links generated for individual LPOS assets.
 *
 * When a share is created from the asset detail panel we record it here so
 * the link persists across panel open/close and is visible on re-visit.
 *
 * Stored at: data/projects/{projectId}/asset-share-links.json
 * Shape: { [assetId: string]: AssetShareLink[] }
 */

import path from 'node:path';
import fs   from 'node:fs';

export interface AssetShareLink {
  shareId:   string;
  shareUrl:  string;
  name:      string;
  createdAt: string; // ISO string
}

type Store = Record<string, AssetShareLink[]>;

function storePath(projectId: string): string {
  return path.join(process.cwd(), 'data', 'projects', projectId, 'asset-share-links.json');
}

function read(projectId: string): Store {
  try {
    return JSON.parse(fs.readFileSync(storePath(projectId), 'utf-8')) as Store;
  } catch {
    return {};
  }
}

function write(projectId: string, data: Store): void {
  const p = storePath(projectId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

export function getAssetShareLinks(projectId: string, assetId: string): AssetShareLink[] {
  return read(projectId)[assetId] ?? [];
}

export function addAssetShareLink(
  projectId: string,
  assetId: string,
  link: AssetShareLink,
): void {
  const data = read(projectId);
  const existing = data[assetId] ?? [];
  // Avoid duplicates — same shareId replaces the old entry
  data[assetId] = [...existing.filter((l) => l.shareId !== link.shareId), link];
  write(projectId, data);
}

export function removeAssetShareLink(
  projectId: string,
  assetId: string,
  shareId: string,
): void {
  const data = read(projectId);
  if (!data[assetId]) return;
  data[assetId] = data[assetId].filter((l) => l.shareId !== shareId);
  write(projectId, data);
}
