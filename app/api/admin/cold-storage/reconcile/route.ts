import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { reconcileBucketFootprint } from '@/lib/services/b2-cold-storage-browser';
import { getColdStorageStats } from '@/lib/store/b2-cold-storage-store';
import { getB2SyncConfig } from '@/lib/store/b2-sync-config-store';

/**
 * GET /api/admin/cold-storage/reconcile
 *
 * On-demand "real footprint" check. Walks every version in the B2 bucket via
 * ListObjectVersions (current + non-current + hide-markers) and returns the
 * true byte breakdown alongside what LPOS tracks locally. Lets an admin see
 * tracked-vs-actual without opening the Backblaze console — and surfaces the
 * dark mass of old/hidden versions that the normal stats query cannot see.
 *
 * Not on the 60s status poll: a full-version walk can be slow on large
 * buckets, so it only runs when the admin clicks "Check live footprint".
 */
export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  try {
    const footprint = await reconcileBucketFootprint();
    const cfg       = getB2SyncConfig();
    const stats     = getColdStorageStats(cfg.retainDays);
    return NextResponse.json({
      footprint,
      tracked: {
        activeObjects: stats.activeObjects,
        activeBytes:   stats.activeBytes,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
