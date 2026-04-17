import { NextRequest, NextResponse } from 'next/server';
import { getPreset } from '@/lib/store/lighting-presets-store';
import { getAmaranService, getWledService } from '@/lib/services/container';

/**
 * POST /api/studio/lighting/presets/[id]/apply
 *
 * Applies all fixture states stored in the preset to the live hardware.
 * Amaran fixtures are commanded in parallel; WLED follows.
 */

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const preset = getPreset(id);
    if (!preset) return NextResponse.json({ error: 'Preset not found' }, { status: 404 });

    const amaran = getAmaranService();
    const wled   = getWledService();

    // Apply Amaran fixture states in parallel
    await Promise.allSettled(
      Object.entries(preset.amaran).map(async ([nodeId, state]) => {
        await amaran.setPower(state.power, nodeId);
        if (state.mode === 'hsi') {
          await amaran.setHSI(state.hue, state.saturation, state.brightness, nodeId);
        } else {
          await amaran.setCCT(state.cct, state.gm, nodeId);
          await amaran.setBrightness(state.brightness, nodeId);
        }
      }),
    );

    // Apply WLED state
    if (preset.wled) {
      const { power, brightness, cctK } = preset.wled;
      const CCT_MIN = 2700;
      const CCT_MAX = 6000;
      const cctPct  = Math.round((cctK - CCT_MIN) / (CCT_MAX - CCT_MIN) * 100);
      await wled.setPower(power);
      await wled.setBrightness(brightness);
      await wled.setCct(Math.max(0, Math.min(100, cctPct)));
    }

    return NextResponse.json({ ok: true, status: amaran.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
