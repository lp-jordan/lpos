'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LightingPreset, PresetFixtureState, PresetWledState } from '@/lib/store/lighting-presets-store';
import type { AmaranStatus } from '@/lib/services/amaran-service';

export type { LightingPreset };

// ── Snapshot helpers ──────────────────────────────────────────────────────────

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));

/** Build an Amaran snapshot from the live status object, clamped to each
 *  fixture's real capabilities so no out-of-range value is ever stored. */
export function snapshotAmaran(
  status: AmaranStatus | null,
): Record<string, PresetFixtureState> {
  if (!status) return {};
  const snap: Record<string, PresetFixtureState> = {};
  for (const fixture of status.fixtures) {
    const s = status.states[fixture.nodeId];
    if (!s) continue;
    const cctMin = fixture.capabilities?.cctMin ?? 2500;
    const cctMax = fixture.capabilities?.cctMax ?? 7500;
    snap[fixture.nodeId] = {
      power:      s.power      ?? false,
      brightness: clamp(s.brightness ?? 50, 0, 100),
      mode:       s.mode       ?? 'cct',
      cct:        clamp(s.cct   ?? 5000, cctMin, cctMax),
      gm:         clamp(s.gm    ?? 100, 0, 200),
      hue:        clamp(s.hue   ?? 0, 0, 360),
      saturation: clamp(s.saturation ?? 100, 0, 100),
    };
  }
  return snap;
}

export interface IncompleteFixture {
  nodeId: string;
  reason: string;
}

/**
 * Find fixtures whose live state is unknown in a way that would corrupt a
 * preset. A preset only applies colour/brightness to fixtures it turns ON, so
 * OFF fixtures only need their power known; ON fixtures also need brightness
 * and the values for whichever colour mode is active. Anything unknown here
 * would otherwise be silently baked in as a hard-coded default.
 */
export function findIncompleteFixtures(status: AmaranStatus | null): IncompleteFixture[] {
  if (!status) return [];
  const issues: IncompleteFixture[] = [];
  for (const fixture of status.fixtures) {
    const s = status.states[fixture.nodeId];
    if (!s || s.power == null) {
      issues.push({ nodeId: fixture.nodeId, reason: 'on/off state unknown' });
      continue;
    }
    if (s.power !== true) continue;             // OFF — colour is irrelevant on apply
    if (s.brightness == null) {
      issues.push({ nodeId: fixture.nodeId, reason: 'brightness unknown' });
      continue;
    }
    if (s.mode == null) {
      issues.push({ nodeId: fixture.nodeId, reason: 'colour mode unknown' });
      continue;
    }
    if (s.mode === 'hsi' && (s.hue == null || s.saturation == null)) {
      issues.push({ nodeId: fixture.nodeId, reason: 'colour unknown' });
    } else if (s.mode === 'cct' && s.cct == null) {
      issues.push({ nodeId: fixture.nodeId, reason: 'colour temperature unknown' });
    }
  }
  return issues;
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
