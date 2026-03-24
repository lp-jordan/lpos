import { NextRequest, NextResponse } from 'next/server';
import { getCameraControlService } from '@/lib/services/container';
import { readStudioConfig } from '@/lib/store/studio-config-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const cfg = readStudioConfig();
  const host = searchParams.get('host') ?? searchParams.get('ip') ?? cfg.camera.host;
  const port = parseInt(searchParams.get('port') ?? String(cfg.camera.port), 10);

  if (!host) {
    return NextResponse.json({ error: 'Camera host not configured' }, { status: 400 });
  }

  try {
    const camera = getCameraControlService();
    const liveview = await camera.openLiveview({ host, port });

    return new Response(liveview.body, {
      headers: {
        'Content-Type': liveview.contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    const status = message.includes('Failed to open liveview stream') ? 502 : 503;
    return NextResponse.json({ error: message }, { status });
  }
}
