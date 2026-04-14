/**
 * GET /api/lp-updates/version
 *
 * Returns the currently hosted LeaderPrompt release metadata.
 * Called by LP clients on startup and periodically to check for updates.
 * No auth required — intended for LP clients on the local/Tailscale network.
 */

import { NextResponse } from 'next/server';
import { getLpReleaseService } from '@/lib/services/container';

export async function GET() {
  const svc = getLpReleaseService();
  if (!svc) {
    return NextResponse.json({ version: null, available: false }, { status: 503 });
  }

  const status = svc.getStatus();
  if (!status.version || !status.dmgFilename) {
    return NextResponse.json({ version: null, available: false });
  }

  return NextResponse.json({
    version:     status.version,
    available:   true,
    dmgFilename: status.dmgFilename,
    lastUpdated: status.lastUpdated,
  });
}
