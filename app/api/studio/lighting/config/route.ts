import { NextRequest, NextResponse } from 'next/server';
import { readStudioConfig, patchStudioConfig } from '@/lib/store/studio-config-store';
import type { AmaranFixtureGroup } from '@/lib/store/studio-config-store';

/**
 * GET   /api/studio/lighting/config
 * PATCH /api/studio/lighting/config
 *
 * Supports partial updates — only the keys present in the body are merged.
 * fixtureLabels and fixtureGroups are merged per-key (not replaced wholesale).
 * fixtureOrder replaces the whole per-group array when provided.
 */

export async function GET() {
  const cfg = readStudioConfig();
  return NextResponse.json({ config: cfg.amaran });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as {
      port?:          number;
      autoConnect?:   boolean;
      fixtureLabels?: Record<string, string>;
      fixtureGroups?: Record<string, AmaranFixtureGroup>;
      fixtureOrder?:  Partial<Record<AmaranFixtureGroup, string[]>>;
    };

    const { fixtureLabels, fixtureGroups, fixtureOrder, ...rest } = body;

    const current = readStudioConfig();
    const amaranPatch = {
      ...rest,
      fixtureLabels: fixtureLabels
        ? { ...current.amaran.fixtureLabels, ...fixtureLabels }
        : current.amaran.fixtureLabels,
      fixtureGroups: fixtureGroups
        ? { ...current.amaran.fixtureGroups, ...fixtureGroups }
        : current.amaran.fixtureGroups,
      fixtureOrder: fixtureOrder
        ? {
            bookshelves: fixtureOrder.bookshelves ?? current.amaran.fixtureOrder.bookshelves,
            void:        fixtureOrder.void        ?? current.amaran.fixtureOrder.void,
            mobile:      fixtureOrder.mobile      ?? current.amaran.fixtureOrder.mobile,
          }
        : current.amaran.fixtureOrder,
    };

    const updated = patchStudioConfig({ amaran: amaranPatch });
    return NextResponse.json({ config: updated.amaran });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
