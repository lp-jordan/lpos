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

// ── Sanitisation ────────────────────────────────────────────────────────────
//
// Last line of defence: whatever a client (or a hand-recovered data file) hands
// us, coerce it into a valid, in-range fixture state before it ever touches
// disk. Out-of-range numbers, NaN, bad modes, and junk nodeIds are clamped or
// dropped here so a corrupt preset can't be created or silently persisted.

const MODE_VALUES = new Set(['cct', 'hsi']);

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitizeFixtureState(raw: unknown): PresetFixtureState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const mode = MODE_VALUES.has(s.mode as string) ? (s.mode as 'cct' | 'hsi') : 'cct';
  return {
    power:      Boolean(s.power),
    brightness: clampInt(s.brightness, 0, 100, 50),
    mode,
    // Store a generous CCT range — the per-fixture capability clamp is applied
    // at apply time (setCCTVerified → clampCct), not here.
    cct:        clampInt(s.cct, 1000, 20000, 5000),
    gm:         clampInt(s.gm, 0, 200, 100),
    hue:        clampInt(s.hue, 0, 360, 0),
    saturation: clampInt(s.saturation, 0, 100, 100),
  };
}

function sanitizeAmaran(raw: unknown): Record<string, PresetFixtureState> {
  const out: Record<string, PresetFixtureState> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [nodeId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!nodeId || typeof nodeId !== 'string') continue;
    const st = sanitizeFixtureState(v);
    if (st) out[nodeId] = st;
  }
  return out;
}

function sanitizeWled(raw: unknown): PresetWledState | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  return {
    power:      Boolean(w.power),
    brightness: clampInt(w.brightness, 0, 100, 50),
    cctK:       clampInt(w.cctK, 2700, 6000, 4000),
  };
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
    amaran: sanitizeAmaran(amaran),
    wled:   sanitizeWled(wled),
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
    amaran:    sanitizeAmaran(amaran),
    wled:      sanitizeWled(wled),
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
