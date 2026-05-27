import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getB2MediaSyncService } from '@/lib/services/container';

/**
 * POST /api/admin/cold-storage/trigger
 *
 * Kicks off a sync run immediately. Returns 409 if a sync is already in
 * progress, 503 if credentials aren't configured. Fire-and-forget — the
 * sync runs asynchronously and the next GET /api/admin/cold-storage will
 * reflect the result once it finishes.
 */
export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const svc = getB2MediaSyncService();
  if (!svc) {
    return NextResponse.json({ error: 'B2MediaSyncService not initialized' }, { status: 503 });
  }

  const status = svc.getStatus();
  if (status.running)    return NextResponse.json({ error: 'Sync already running' }, { status: 409 });
  if (!status.configured) return NextResponse.json({ error: 'B2 credentials not configured' }, { status: 503 });

  void svc.runSync();
  return NextResponse.json({ triggered: true });
}
