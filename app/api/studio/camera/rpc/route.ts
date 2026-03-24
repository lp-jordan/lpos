import { NextRequest, NextResponse } from 'next/server';
import { getCameraControlService } from '@/lib/services/container';
import { readStudioConfig } from '@/lib/store/studio-config-store';

interface RpcBody {
  method: string;
  params?: unknown[];
  host?: string;
  ip?: string;
  port?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as RpcBody;
    const cfg = readStudioConfig();
    const host = body.host ?? body.ip ?? cfg.camera.host;
    const port = body.port ?? cfg.camera.port;
    const camera = getCameraControlService();

    if (!host) {
      return NextResponse.json({ error: 'Camera host not configured' }, { status: 400 });
    }

    switch (body.method) {
      case 'getAvailableApiList':
        return NextResponse.json({ result: await camera.getAvailableApiList({ host, port }) });

      case 'getEvent':
        return NextResponse.json({ result: await camera.getCameraEvent({ host, port }) });

      case 'startMovieRec':
        await camera.startMovieRec({ host, port });
        return NextResponse.json({ ok: true });

      case 'stopMovieRec':
        await camera.stopMovieRec({ host, port });
        return NextResponse.json({ ok: true });

      case 'getAvailableWhiteBalance':
        return NextResponse.json({ result: await camera.getAvailableWhiteBalance({ host, port }) });

      case 'setWhiteBalance': {
        const [mode] = (body.params ?? []) as [string];
        await camera.setWhiteBalance(mode, { host, port });
        return NextResponse.json({ ok: true });
      }

      case 'getAvailableIsoSpeedRate':
        return NextResponse.json({ result: await camera.getAvailableIsoSpeedRate({ host, port }) });

      case 'setIsoSpeedRate': {
        const [iso] = (body.params ?? []) as [string];
        await camera.setIsoSpeedRate(iso, { host, port });
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json(await camera.callMethod(body.method, body.params ?? [], { host, port }));
    }
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('not reachable')
      ? 503
      : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
