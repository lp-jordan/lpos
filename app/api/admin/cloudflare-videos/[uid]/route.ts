/**
 * DELETE /api/admin/cloudflare-videos/[uid] — permanently delete a video from Cloudflare Stream.
 *
 * Admin-only. This is the management side of the Cloudflare Library panel: it frees minutes
 * against the 3000-minute storage budget. Deleting a UID that LPOS still considers LIVE would
 * break the embed wherever that asset is served, so we refuse unless the caller passes
 * ?allowLive=1 (the UI only sends that after a stronger confirmation).
 *
 * Like the orphan-purge route, this only touches Cloudflare — it does not rewrite LPOS
 * distribution_records. Deleting a live asset therefore leaves LPOS pointing at a dead video
 * until the asset is re-published; that is why the live guard exists.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { deleteCloudflareVideo } from '@/lib/services/cloudflare-stream';
import { getLiveCloudflareUids } from '@/lib/store/canonical-asset-store';

type Ctx = { params: Promise<{ uid: string }> };

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const { uid } = await params;
  const allowLive = req.nextUrl.searchParams.get('allowLive') === '1';

  if (!allowLive && getLiveCloudflareUids().has(uid)) {
    return NextResponse.json(
      { error: 'This video is the live Cloudflare publication of an active asset. Deleting it will break the embed. Re-send with allowLive=1 to override.', isLive: true },
      { status: 409 },
    );
  }

  try {
    await deleteCloudflareVideo(uid);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
