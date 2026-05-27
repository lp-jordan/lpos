import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getB2MediaSyncService } from '@/lib/services/container';

/**
 * POST /api/admin/cold-storage/cancel
 *
 * Signals the in-progress sync to stop. The service aborts any in-flight
 * multipart upload (AWS SDK's Upload.abort()), exits the file-walk loop,
 * and SKIPS the missing-stamp + retention-deletion steps so a partial
 * cancel doesn't poison the tracking table. Returns 409 if no sync is
 * running.
 */
export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const svc = getB2MediaSyncService();
  if (!svc) {
    return NextResponse.json({ error: 'B2MediaSyncService not initialized' }, { status: 503 });
  }

  const accepted = await svc.cancelCurrentRun();
  if (!accepted) {
    return NextResponse.json({ error: 'No sync currently running' }, { status: 409 });
  }
  return NextResponse.json({ cancelling: true });
}
