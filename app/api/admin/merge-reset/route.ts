/**
 * POST /api/admin/merge-reset
 *
 * Wipes all merge state so projects can be re-linked from scratch.
 * Clears: asset_link_locks, asset_merge_jobs, asset_link_groups,
 * and resets asset_link_group_id on all projects.
 *
 * Optional body: { groupId: string } — scope the reset to one group only.
 * Omit body to reset everything.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getCoreDb } from '@/lib/store/core-db';
import { getProjectStore } from '@/lib/services/container';
import { getCache, writeCache } from '@/lib/services/drive-folder-service';

export async function POST(req: NextRequest) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const body = await req.json().catch(() => ({})) as { groupId?: string };
  const { groupId } = body;

  const db = getCoreDb();

  if (groupId) {
    // Scope to one group
    db.prepare(`DELETE FROM asset_link_locks WHERE project_id IN (
      SELECT source_project_id FROM asset_merge_jobs WHERE group_id = ?
    )`).run(groupId);
    db.prepare(`DELETE FROM asset_merge_jobs WHERE group_id = ?`).run(groupId);
    db.prepare(`UPDATE projects SET asset_link_group_id = NULL WHERE asset_link_group_id = ?`).run(groupId);
    db.prepare(`DELETE FROM asset_link_groups WHERE group_id = ?`).run(groupId);
    console.log(`[admin] Merge state reset for group ${groupId}`);
  } else {
    // Full reset
    db.prepare(`DELETE FROM asset_link_locks`).run();
    db.prepare(`DELETE FROM asset_merge_jobs`).run();
    db.prepare(`UPDATE projects SET asset_link_group_id = NULL WHERE asset_link_group_id IS NOT NULL`).run();
    db.prepare(`DELETE FROM asset_link_groups`).run();
    console.log(`[admin] Full merge state reset`);
  }

  // Clear shared asset folder cache entries
  try {
    const cache = getCache();
    if (groupId) {
      delete cache.sharedAssetFolders[groupId];
    } else {
      cache.sharedAssetFolders = {};
    }
    writeCache(cache);
  } catch {
    // Cache clear failure is non-fatal
  }

  // Push updated project list to all connected clients
  getProjectStore().broadcastAll();

  return NextResponse.json({ ok: true, message: groupId ? `Group ${groupId} reset` : 'Full merge reset complete' });
}
