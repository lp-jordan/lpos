import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getB2MediaSyncService } from '@/lib/services/container';
import { getB2SyncConfig } from '@/lib/store/b2-sync-config-store';
import {
  getColdStorageStats,
  listQueuedForDeletion,
  listMissingWithinRetention,
} from '@/lib/store/b2-cold-storage-store';

/**
 * GET /api/admin/cold-storage
 *
 * Returns the full status snapshot for the Raw Footage Cold Storage admin
 * page: service status (configured/running/next run/last run), the live
 * stats (active object count + bytes, missing-but-still-in-retention,
 * queued-for-deletion, deleted-history), and the queued-for-deletion list
 * (up to 200 entries).
 */
export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const svc = getB2MediaSyncService();
  const status = svc?.getStatus() ?? {
    configured:  false,
    running:     false,
    nextRunHour: 2,
    syncDirs:    [],
    retainDays:  30,
    lastRun:     null,
  };

  const cfg     = getB2SyncConfig();
  const stats   = getColdStorageStats(cfg.retainDays);
  const queued  = listQueuedForDeletion(cfg.retainDays).slice(0, 200);
  const missing = listMissingWithinRetention(cfg.retainDays).slice(0, 200);

  return NextResponse.json({
    status,
    config: cfg,
    stats,
    queuedForDeletion: queued,
    missingWithinRetention: missing,
  });
}
