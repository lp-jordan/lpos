/**
 * GET/PUT /api/admin/share-app — LP Share connection (admin only).
 *   GET → { origin, sync: { configured, lastOkAt, lastError }, secrets: { ingestToken, staffSecret } }
 *   PUT { origin } → set the `share_app.origin` knob ('' disconnects).
 * Secrets stay in Doppler; this only reports whether they're present.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { setSetting } from '@/lib/store/lpos-settings-store';
import { SHARE_APP_ORIGIN_KEY, shareAppOrigin, shareAppSyncStatus, syncShareAppOnce } from '@/lib/services/share-app';

function state() {
  return {
    origin: shareAppOrigin(),
    sync: shareAppSyncStatus(),
    secrets: {
      ingestToken: !!process.env.SHARE_APP_INGEST_TOKEN?.trim(),
      staffSecret: (process.env.SHARE_STAFF_SECRET?.trim().length ?? 0) >= 16,
    },
  };
}

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;
  return NextResponse.json(state());
}

export async function PUT(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;
  const body = await req.json().catch(() => null) as { origin?: string } | null;
  const origin = (body?.origin ?? '').trim();
  if (origin && !/^https?:\/\/[^/\s]+\/?$/i.test(origin)) {
    return NextResponse.json({ error: 'Use a bare origin like https://share.leaderpass.com' }, { status: 400 });
  }
  setSetting(SHARE_APP_ORIGIN_KEY, origin.replace(/\/+$/, ''));
  if (origin) await syncShareAppOnce();
  return NextResponse.json(state());
}
