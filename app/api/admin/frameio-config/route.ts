import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { setSetting, SETTING_KEYS } from '@/lib/store/lpos-settings-store';
import { isFrameioAutoUploadEnabled } from '@/lib/services/frameio-upload';

/**
 * GET/PUT /api/admin/frameio-config — the automatic Frame.io upload switch (admin only).
 *   GET → { autoUpload }
 *   PUT { autoUpload: boolean } → set `frameio.auto_upload`. Takes effect on the next ingest.
 */

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;
  return NextResponse.json({ autoUpload: isFrameioAutoUploadEnabled() });
}

export async function PUT(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;
  const body = await req.json().catch(() => null) as { autoUpload?: unknown } | null;
  if (typeof body?.autoUpload !== 'boolean') {
    return NextResponse.json({ error: 'autoUpload must be true or false' }, { status: 400 });
  }
  setSetting<boolean>(SETTING_KEYS.FRAMEIO_AUTO_UPLOAD, body.autoUpload);
  return NextResponse.json({ autoUpload: isFrameioAutoUploadEnabled() });
}
