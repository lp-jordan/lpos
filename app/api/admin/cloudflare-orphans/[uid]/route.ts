/**
 * DELETE /api/admin/cloudflare-orphans/[uid]
 *
 * Manually purge a Cloudflare orphan: deletes the video at Cloudflare, then
 * marks the orphan row as purged so it stops appearing in the active list.
 *
 * Admin-only. Auto-deletion is intentionally NOT done by the reconciler — this
 * route is the only path that actually calls Cloudflare's delete API for orphans.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { deleteCloudflareVideo } from '@/lib/services/cloudflare-stream';
import { getOrphan, markOrphanAttempt, markOrphanPurged } from '@/lib/store/cloudflare-orphan-store';

type Ctx = { params: Promise<{ uid: string }> };

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const { uid } = await params;
  const orphan = getOrphan(uid);
  if (!orphan) {
    return NextResponse.json({ error: 'Orphan not found' }, { status: 404 });
  }
  if (orphan.purgedAt) {
    return NextResponse.json({ error: 'Already purged' }, { status: 409 });
  }

  try {
    await deleteCloudflareVideo(uid);
    markOrphanPurged(uid);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markOrphanAttempt(uid, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
