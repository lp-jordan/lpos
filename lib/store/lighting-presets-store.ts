/**
 * Lighting presets — persisted at data/lighting-presets.json
 *
 * A preset captures the full state of every connected Amaran fixture
 * plus the WLED bookshelf LEDs, and can be applied in one click.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PRESETS_PATH = path.join(process.cwd(), 'data', 'lighting-presets.json');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PresetFixtureState {
  power:      boolean;
  brightness: number;   // 0–100
  mode:       'cct' | 'hsi';
  cct:        number;   // Kelvin
  gm:         number;   // 0–200, 100 = neutral
  hue:        number;   // 0–360
  saturation: number;   // 0–100
}

export interface PresetWledState {
  power:      boolean;
  brightness: number;   // 0–100
  cctK:       number;   // Kelvin (2700–6000)
}

export interface LightingPreset {
  id:        string;
  name:      string;
  amaran:    Record<string, PresetFixtureState>;  // nodeId → state
  wled:      PresetWledState | null;
  createdAt: string;
  updatedAt: string;
}

// ── IO ────────────────────────────────────────────────────────────────────────

function readAll(): LightingPreset[] {
  try {
    const raw = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf-8')) as unknown;
    if (Array.isArray(raw)) return raw as LightingPreset[];
  } catch { /* first run */ }
  return [];
}

function writeAll(presets: LightingPreset[]): void {
  fs.mkdirSync(path.dirname(PRESETS_PATH), { recursive: true });
  fs.writeFileSync(PRESETS_PATH, JSON.stringify(presets, null, 2), 'utf-8');
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function listPresets(): LightingPreset[] {
  return readAll();
}

export function createPreset(
  name:   string,
  amaran: Record<string, PresetFixtureState>,
  wled:   PresetWledState | null,
): LightingPreset {
  const now    = new Date().toISOString();
  const preset: LightingPreset = {
    id: randomUUID(),
    name: name.trim() || 'Untitled Preset',
    amaran,
    wled,
    createdAt: now,
    updatedAt: now,
  };
  const all = readAll();
  all.push(preset);
  writeAll(all);
  return preset;
}

export function updatePreset(
  id:      string,
  name:    string,
  amaran:  Record<string, PresetFixtureState>,
  wled:    PresetWledState | null,
): LightingPreset | null {
  const all = readAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  all[idx] = {
    ...all[idx],
    name:      name.trim() || all[idx].name,
    amaran,
    wled,
    updatedAt: new Date().toISOString(),
  };
  writeAll(all);
  return all[idx];
}

export function deletePreset(id: string): boolean {
  const all = readAll();
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

export function getPreset(id: string): LightingPreset | null {
  return readAll().find((p) => p.id === id) ?? null;
}
