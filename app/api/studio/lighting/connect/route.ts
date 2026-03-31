import { NextRequest, NextResponse } from 'next/server';
import { getAmaranService } from '@/lib/services/container';

/**
 * POST /api/studio/lighting/connect   — connect to Amaran Desktop
 * DELETE /api/studio/lighting/connect — disconnect
 */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as { port?: number };
    const service = getAmaranService();
    service.connect(body.port);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const service = getAmaranService();
    service.disconnect();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
