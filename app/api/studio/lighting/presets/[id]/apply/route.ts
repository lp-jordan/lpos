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

    // Apply Amaran fixture states sequentially.
    // AmaranService.pending is keyed by action name ("set_sleep", "set_cct", etc.),
    // so parallel calls for the same action overwrite each other's resolver and
    // only the last one resolves. Sequential processing avoids that collision.
    const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    for (const [nodeId, state] of Object.entries(preset.amaran)) {
      // setPower failure is non-fatal — the light may already be in the desired
      // state or have a transient Bluetooth hiccup. Always attempt color/brightness.
      try { await amaran.setPower(state.power, nodeId); } catch { /* continue */ }

      if (!state.power) continue;

      // After waking a fixture from sleep, the Bluetooth handshake completes
      // before the WS response arrives, but the fixture needs ~300 ms before it
      // will reliably accept CCT / brightness commands.
      await delay(300);

      if (state.mode === 'hsi') {
        try { await amaran.setHSI(state.hue, state.saturation, state.brightness, nodeId); } catch { /* skip */ }
      } else {
        try { await amaran.setCCT(state.cct, state.gm, nodeId); } catch { /* skip */ }
        try { await amaran.setBrightness(state.brightness, nodeId); } catch { /* skip */ }
      }
    }

    // Apply WLED state
    if (preset.wled) {
      const { power, brightness, cctK } = preset.wled;
      const CCT_MIN = 2700;
      const CCT_MAX = 6000;
      const cctPct  = Math.round((cctK - CCT_MIN) / (CCT_MAX - CCT_MIN) * 100);
      await wled.setPower(power);
      // Only set brightness/CCT when on — WLED auto-powers-on when bri is posted
      if (power) {
        await wled.setBrightness(brightness);
        await wled.setCct(Math.max(0, Math.min(100, cctPct)));
      }
    }

    // Re-poll fixture state so the UI reflects what the hardware actually applied.
    await amaran.refreshStatus().catch(() => {});

    return NextResponse.json({ ok: true, status: amaran.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
