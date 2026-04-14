import { NextRequest, NextResponse } from 'next/server';
import { readStudioConfig, patchStudioConfig } from '@/lib/store/studio-config-store';
import { getWledService } from '@/lib/services/container';

/**
 * GET   /api/studio/wled/config — read WLED config
 * PATCH /api/studio/wled/config — update IP address
 */

export async function GET() {
  const cfg = readStudioConfig();
  return NextResponse.json({ config: cfg.wled });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as { ip?: string };
    const updated = patchStudioConfig({ wled: body });
    // Hot-reload the service so it starts polling the new IP immediately
    getWledService().reconfigure(updated.wled.ip);
    return NextResponse.json({ config: updated.wled });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
