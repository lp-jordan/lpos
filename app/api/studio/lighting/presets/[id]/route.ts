import { NextRequest, NextResponse } from 'next/server';
import { updatePreset, deletePreset } from '@/lib/store/lighting-presets-store';
import type { PresetFixtureState, PresetWledState } from '@/lib/store/lighting-presets-store';

/**
 * PATCH  /api/studio/lighting/presets/[id]  — update preset name + state snapshot
 * DELETE /api/studio/lighting/presets/[id]  — delete preset
 */

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id }  = await params;
    const body    = await req.json() as {
      name:   string;
      amaran: Record<string, PresetFixtureState>;
      wled:   PresetWledState | null;
    };
    const updated = updatePreset(id, body.name, body.amaran ?? {}, body.wled ?? null);
    if (!updated) return NextResponse.json({ error: 'Preset not found' }, { status: 404 });
    return NextResponse.json({ preset: updated });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok     = deletePreset(id);
  if (!ok) return NextResponse.json({ error: 'Preset not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
