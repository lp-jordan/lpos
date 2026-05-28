import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getB2SyncConfig } from '@/lib/store/b2-sync-config-store';
import { listQueuedForDeletion } from '@/lib/store/b2-cold-storage-store';
import { deleteOne } from '@/lib/services/b2-cold-storage-browser';

/**
 * POST /api/admin/cold-storage/approve-all
 *
 * Bulk-approve every object currently in the awaiting-review list (those
 * whose missing_since has aged past retainDays). For each, deletes from B2
 * and stamps deleted_at via the existing single-object delete path. Returns
 * the count plus a per-key error list for anything that failed mid-loop.
 *
 * Deliberately processes serially — keeps B2 happy and lets a partial
 * failure not poison the whole batch (each delete is independent).
 */
export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const cfg     = getB2SyncConfig();
  const queued  = listQueuedForDeletion(cfg.retainDays);
  let deleted   = 0;
  const errors: Array<{ key: string; error: string }> = [];

  for (const obj of queued) {
    try {
      await deleteOne(obj.key);
      deleted++;
    } catch (err) {
      errors.push({ key: obj.key, error: (err as Error).message });
    }
  }

  return NextResponse.json({ approved: queued.length, deleted, errors });
}
