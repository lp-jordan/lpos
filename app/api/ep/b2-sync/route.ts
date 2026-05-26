import { NextRequest, NextResponse } from 'next/server';
import { requireEpSecret } from '@/lib/services/ep-auth';
import { getB2MediaSyncService } from '@/lib/services/container';

/**
 * GET /api/ep/b2-sync
 * Returns the current B2 media sync status (last run result + live state).
 */
export async function GET(req: NextRequest) {
  const authError = requireEpSecret(req);
  if (authError) return authError;

  const svc = getB2MediaSyncService();
  if (!svc) {
    return NextResponse.json({ ok: false, error: 'B2MediaSyncService not initialized' }, { status: 503 });
  }

  return NextResponse.json({ ok: true, data: svc.getStatus() });
}

/**
 * POST /api/ep/b2-sync
 * Triggers a manual sync run. Responds immediately — sync runs in background.
 * Returns 409 if a sync is already running.
 */
export async function POST(req: NextRequest) {
  const authError = requireEpSecret(req);
  if (authError) return authError;

  const svc = getB2MediaSyncService();
  if (!svc) {
    return NextResponse.json({ ok: false, error: 'B2MediaSyncService not initialized' }, { status: 503 });
  }

  const status = svc.getStatus();
  if (status.running) {
    return NextResponse.json({ ok: false, error: 'Sync already running' }, { status: 409 });
  }
  if (!status.configured) {
    return NextResponse.json({ ok: false, error: 'B2 credentials not configured' }, { status: 503 });
  }

  // Fire and forget — don't await
  void svc.runSync();

  return NextResponse.json({ ok: true, data: { triggered: true } });
}
