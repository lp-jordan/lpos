/**
 * Generic operational-knob KV — the SQLite-backed home for tunable values that
 * the admin should be able to change without a redeploy (per workspace memory
 * feedback_doppler_vs_admin_settings: credentials live in Doppler, knobs live
 * here). Values are JSON-encoded so the same table can hold numbers, strings,
 * booleans, and small arrays/objects.
 *
 * Primary consumer today is the MonitorRegistry — each monitor reads its
 * thresholds and enable/disable toggle from here. As more knobs land (brain
 * agent thresholds, etc.) they slot into this same table.
 */

import { getCoreDb } from './core-db';

interface Row {
  key:        string;
  value:      string;
  updated_at: string;
}

/** Read a setting; returns `fallback` if the key is unset or the stored JSON is unparseable. */
export function getSetting<T>(key: string, fallback: T): T {
  const row = getCoreDb()
    .prepare('SELECT value FROM lpos_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

/** Write a setting; overwrites any existing row for the same key. */
export function setSetting<T>(key: string, value: T): void {
  const now = new Date().toISOString();
  getCoreDb()
    .prepare(`
      INSERT INTO lpos_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
    .run(key, JSON.stringify(value), now);
}

/** List every setting — used by the admin Settings page to render the knobs. */
export function listSettings(): Array<{ key: string; value: unknown; updatedAt: string }> {
  const rows = getCoreDb()
    .prepare('SELECT key, value, updated_at FROM lpos_settings ORDER BY key')
    .all() as Row[];
  return rows.map((r) => {
    let parsed: unknown;
    try { parsed = JSON.parse(r.value); } catch { parsed = r.value; }
    return { key: r.key, value: parsed, updatedAt: r.updated_at };
  });
}

// ─── Well-known keys (so callers don't typo and the set of knobs is discoverable) ─────

export const SETTING_KEYS = {
  /** How many days of inactivity on a pending handoff before LPOS re-pings. */
  HANDOFF_STALE_THRESHOLD_DAYS: 'handoff.stale_threshold_days',
  /** How often the HandoffStaleMonitor sweeps for due re-pings (minutes). */
  HANDOFF_MONITOR_TICK_MINUTES: 'handoff.monitor_tick_minutes',
} as const;

export const SETTING_DEFAULTS = {
  [SETTING_KEYS.HANDOFF_STALE_THRESHOLD_DAYS]: 3,
  [SETTING_KEYS.HANDOFF_MONITOR_TICK_MINUTES]: 15,
} as const;
