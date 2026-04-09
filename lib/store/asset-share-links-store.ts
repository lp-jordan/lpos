/**
 * Tracks share links generated for individual LPOS assets.
 *
 * When a share is created from the asset detail panel we record it here so
 * the link persists across panel open/close and is visible on re-visit.
 */

import { getCoreDb } from './core-db';

export interface AssetShareLink {
  shareId:   string;
  shareUrl:  string;
  name:      string;
  createdAt: string; // ISO string
}

interface LinkRow {
  project_id: string;
  asset_id: string;
  share_id: string;
  share_url: string;
  name: string;
  created_at: string;
}

function rowToLink(row: LinkRow): AssetShareLink {
  return { shareId: row.share_id, shareUrl: row.share_url, name: row.name, createdAt: row.created_at };
}

export function getAssetShareLinks(projectId: string, assetId: string): AssetShareLink[] {
  return (getCoreDb()
    .prepare('SELECT * FROM asset_share_links WHERE project_id = ? AND asset_id = ? ORDER BY created_at ASC')
    .all(projectId, assetId) as LinkRow[])
    .map(rowToLink);
}

export function addAssetShareLink(projectId: string, assetId: string, link: AssetShareLink): void {
  getCoreDb().prepare(
    `INSERT INTO asset_share_links (project_id, asset_id, share_id, share_url, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, asset_id, share_id) DO UPDATE SET
       share_url = excluded.share_url,
       name      = excluded.name`,
  ).run(projectId, assetId, link.shareId, link.shareUrl, link.name, link.createdAt);
}

export function removeAssetShareLink(projectId: string, assetId: string, shareId: string): void {
  getCoreDb().prepare(
    'DELETE FROM asset_share_links WHERE project_id = ? AND asset_id = ? AND share_id = ?',
  ).run(projectId, assetId, shareId);
}
