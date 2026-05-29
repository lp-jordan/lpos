/**
 * GET /api/ep-updates/version
 *
 * Returns the currently hosted EditPanel release metadata.
 * Called by editpanel clients / the /ep-update page to check for updates.
 * Public (allow-listed in middleware) — version metadata is low-sensitivity.
 */

import { NextResponse } from 'next/server';
import { getEpReleaseService } from '@/lib/services/container';

export async function GET() {
  const svc = getEpReleaseService();
  if (!svc) {
    return NextResponse.json({ version: null, available: false }, { status: 503 });
  }

  const status = svc.getStatus();
  if (!status.version || !status.installerFilename) {
    return NextResponse.json({ version: null, available: false });
  }

  return NextResponse.json({
    version:           status.version,
    available:         true,
    installerFilename: status.installerFilename,
    lastUpdated:       status.lastUpdated,
  });
}
