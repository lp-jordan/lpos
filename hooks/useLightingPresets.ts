'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LightingPreset, PresetFixtureState, PresetWledState } from '@/lib/store/lighting-presets-store';
import type { AmaranStatus } from '@/lib/services/amaran-service';

export type { LightingPreset };

// ── Snapshot helpers ──────────────────────────────────────────────────────────

/** Build an Amaran snapshot from the live status object. */
export function snapshotAmaran(
  status: AmaranStatus | null,
): Record<string, PresetFixtureState> {
  if (!status) return {};
  const snap: Record<string, PresetFixtureState> = {};
  for (const fixture of status.fixtures) {
    const s = status.states[fixture.nodeId];
    if (!s) continue;
    snap[fixture.nodeId] = {
      power:      s.power      ?? false,
      brightness: s.brightness ?? 50,
      mode:       s.mode       ?? 'cct',
      cct:        s.cct        ?? 5000,
      gm:         s.gm         ?? 100,
      hue:        s.hue        ?? 0,
      saturation: s.saturation ?? 100,
    };
  }
  return snap;
}

/** Build a WLED snapshot from the current slider values (passed in from WledPanel state). */
export function snapshotWled(
  power: boolean,
  brightness: number,
  cctK: number,
): PresetWledState {
  return { power, brightness, cctK };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useLightingPresets() {
  const [presets,  setPresets]  = useState<LightingPreset[]>([]);
  const [applying, setApplying] = useState<string | null>(null); // preset id being applied

  const load = useCallback(async () => {
    try {
      const res  = await fetch('/api/studio/lighting/presets');
      const data = await res.json() as { presets?: LightingPreset[] };
      if (data.presets) setPresets(data.presets);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const savePreset = useCallback(async (
    name:   string,
    amaran: Record<string, PresetFixtureState>,
    wled:   PresetWledState | null,
  ): Promise<LightingPreset | null> => {
    try {
      const res  = await fetch('/api/studio/lighting/presets', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, amaran, wled }),
      });
      const data = await res.json() as { preset?: LightingPreset };
      if (data.preset) {
        setPresets((prev) => [...prev, data.preset!]);
        return data.preset;
      }
    } catch { /* ignore */ }
    return null;
  }, []);

  const updatePreset = useCallback(async (
    id:     string,
    name:   string,
    amaran: Record<string, PresetFixtureState>,
    wled:   PresetWledState | null,
  ): Promise<boolean> => {
    try {
      const res  = await fetch(`/api/studio/lighting/presets/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, amaran, wled }),
      });
      const data = await res.json() as { preset?: LightingPreset };
      if (data.preset) {
        setPresets((prev) => prev.map((p) => p.id === id ? data.preset! : p));
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }, []);

  const deletePreset = useCallback(async (id: string): Promise<void> => {
    try {
      await fetch(`/api/studio/lighting/presets/${id}`, { method: 'DELETE' });
      setPresets((prev) => prev.filter((p) => p.id !== id));
    } catch { /* ignore */ }
  }, []);

  const applyPreset = useCallback(async (id: string): Promise<void> => {
    setApplying(id);
    try {
      await fetch(`/api/studio/lighting/presets/${id}/apply`, { method: 'POST' });
    } catch { /* ignore */ }
    finally { setApplying(null); }
  }, []);

  return {
    presets,
    applying,
    savePreset,
    updatePreset,
    deletePreset,
    applyPreset,
  };
}
