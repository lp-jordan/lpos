import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getB2SyncConfig, setB2SyncConfig } from '@/lib/store/b2-sync-config-store';
import { isB2MediaConfigured } from '@/lib/services/b2-media-sync-service';

/** GET /api/admin/b2-sync-config — admin reads the current operational config. */
export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;
  return NextResponse.json({
    config:        getB2SyncConfig(),
    credsConfigured: isB2MediaConfigured(),
  });
}

/**
 * PUT /api/admin/b2-sync-config — partial update.
 * Body: { syncDirs?: string[], retainDays?: number, syncHour?: number }
 *
 * Live: B2MediaSyncService re-reads on every minute poll, so changes take
 * effect without a restart.
 */
export async function PUT(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  let body: Partial<{ syncDirs: string[]; retainDays: number; syncHour: number; paused: boolean }>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Light validation — store layer also sanitises/clamps.
  const patch: Partial<{ syncDirs: string[]; retainDays: number; syncHour: number; paused: boolean }> = {};
  if (Array.isArray(body.syncDirs)) {
    patch.syncDirs = body.syncDirs.filter((v): v is string => typeof v === 'string');
  }
  if (typeof body.retainDays === 'number')  patch.retainDays = body.retainDays;
  if (typeof body.syncHour   === 'number')  patch.syncHour   = body.syncHour;
  if (typeof body.paused     === 'boolean') patch.paused     = body.paused;

  const config = setB2SyncConfig(patch);
  return NextResponse.json({ config });
}
