import { NextRequest, NextResponse } from 'next/server';
import { listPresets, createPreset } from '@/lib/store/lighting-presets-store';
import type { PresetFixtureState, PresetWledState } from '@/lib/store/lighting-presets-store';

/**
 * GET  /api/studio/lighting/presets  — list all presets
 * POST /api/studio/lighting/presets  — create preset from current state snapshot
 *
 * POST body: { name: string, amaran: Record<nodeId, PresetFixtureState>, wled: PresetWledState | null }
 */

export async function GET() {
  return NextResponse.json({ presets: listPresets() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      name:   string;
      amaran: Record<string, PresetFixtureState>;
      wled:   PresetWledState | null;
    };
    const preset = createPreset(body.name, body.amaran ?? {}, body.wled ?? null);
    return NextResponse.json({ preset }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
