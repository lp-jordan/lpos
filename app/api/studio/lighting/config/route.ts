import { NextRequest, NextResponse } from 'next/server';
import { readStudioConfig, patchStudioConfig } from '@/lib/store/studio-config-store';

/**
 * GET   /api/studio/lighting/config — read Amaran config
 * PATCH /api/studio/lighting/config — update port / autoConnect
 */

export async function GET() {
  const cfg = readStudioConfig();
  return NextResponse.json({ config: cfg.amaran });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as { port?: number; autoConnect?: boolean };
    const updated = patchStudioConfig({ amaran: body });
    return NextResponse.json({ config: updated.amaran });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
