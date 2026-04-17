import { NextRequest, NextResponse } from 'next/server';
import { getAmaranService } from '@/lib/services/container';

/**
 * GET  /api/studio/lighting  — current Amaran status
 * POST /api/studio/lighting  — send a control command
 *
 * POST body: { method: string, nodeId?: string, params?: Record<string, unknown> }
 *
 * nodeId targets a specific fixture. If omitted, the first discovered fixture is used.
 *
 * Supported methods:
 *   setPower       { on: boolean }
 *   setBrightness  { pct: number }                        0–100
 *   setCCT         { kelvin: number, gm?: number }        kelvin 2500–7500, gm 0–200
 *   setHSI         { hue, saturation, brightness }        all 0–100 except hue 0–360
 *   refreshStatus  {}
 */

export async function GET() {
  const service = getAmaranService();
  return NextResponse.json({ status: service.status });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { method?: string; nodeId?: string; params?: Record<string, unknown> };
    const service = getAmaranService();
    const nodeId = body.nodeId;

    switch (body.method) {
      case 'setPower':
        await service.setPower(Boolean(body.params?.on), nodeId);
        break;
      case 'setBrightness':
        await service.setBrightness(Number(body.params?.pct), nodeId);
        break;
      case 'setCCT':
        await service.setCCT(
          Number(body.params?.kelvin),
          body.params?.gm != null ? Number(body.params.gm) : undefined,
          nodeId,
        );
        break;
      case 'setHSI':
        await service.setHSI(
          Number(body.params?.hue),
          Number(body.params?.saturation),
          Number(body.params?.brightness),
          nodeId,
        );
        break;
      case 'refreshStatus':
        await service.refreshStatus();
        break;
      case 'rediscover':
        await service.rediscover();
        break;
      default:
        return NextResponse.json({ error: `Unknown method: ${body.method ?? '(none)'}` }, { status: 400 });
    }

    return NextResponse.json({ ok: true, status: service.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not connected') ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
