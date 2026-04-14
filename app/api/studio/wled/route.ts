import { NextRequest, NextResponse } from 'next/server';
import { getWledService } from '@/lib/services/container';

/**
 * GET  /api/studio/wled  — current WLED status
 * POST /api/studio/wled  — send a control command
 *
 * POST body: { method: string, params?: Record<string, unknown> }
 *
 * Supported methods:
 *   setPower       { on: boolean }
 *   setBrightness  { pct: number }    0–100
 *   setCct         { pct: number }    0–100 (0 = cold, 100 = warm)
 *   setEffect      { id: number }
 *   applyPreset    { id: number }
 *   refreshStatus  {}
 */

export async function GET() {
  const service = getWledService();
  return NextResponse.json({ status: service.status });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { method?: string; params?: Record<string, unknown> };
    const service = getWledService();

    switch (body.method) {
      case 'setPower':
        await service.setPower(Boolean(body.params?.on));
        break;
      case 'setBrightness':
        await service.setBrightness(Number(body.params?.pct));
        break;
      case 'setCct':
        await service.setCct(Number(body.params?.pct));
        break;
      case 'setEffect':
        await service.setEffect(Number(body.params?.id));
        break;
      case 'applyPreset':
        await service.applyPreset(Number(body.params?.id));
        break;
      case 'refreshStatus':
        await service.refreshStatus();
        break;
      default:
        return NextResponse.json({ error: `Unknown method: ${body.method ?? '(none)'}` }, { status: 400 });
    }

    return NextResponse.json({ ok: true, status: service.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not configured') ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
