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

  /** How many days an Editing task may sit in Review before LPOS re-pings its assignees. */
  REVIEW_STALE_THRESHOLD_DAYS: 'review.stale_threshold_days',
  /** How often the ReviewStaleMonitor sweeps for due Review check-ins (minutes). */
  REVIEW_MONITOR_TICK_MINUTES: 'review.monitor_tick_minutes',

  // ── Transcription (whisper.cpp) ──────────────────────────────────────────
  /** whisper.cpp ggml model name (without the `ggml-` prefix or `.bin` suffix). */
  TRANSCRIPTION_MODEL: 'transcription.model',
  /** Concurrent whisper.cpp workers. Big models (large-v3*) want 1 to avoid GPU contention. */
  TRANSCRIPTION_WORKERS: 'transcription.workers',
  /**
   * Per-job timeout. When length-aware mode is on this is a floor; the effective
   * timeout scales with video duration. When off it is a fixed cap. Minutes.
   */
  TRANSCRIPTION_TIMEOUT_MINUTES: 'transcription.timeout_minutes',
  /** If true, derive the per-job timeout from the media duration (recommended for big models). */
  TRANSCRIPTION_TIMEOUT_LENGTH_AWARE: 'transcription.timeout_length_aware',

  // ── Daily Catch-Up ────────────────────────────────────────────────────────
  /**
   * Master switch for the AI headline on the Daily Catch-Up drawer. When false,
   * the drawer still renders the full deterministic recap — it just skips the
   * one-sentence Claude summary and makes zero API calls (mirrors the old
   * WHATS_NEW_ENABLED kill switch). The grouped recap never depends on Claude.
   */
  CATCHUP_AI_ENABLED: 'catchup.ai_enabled',
  /** Model used for the Daily Catch-Up headline. Haiku is plenty for a 1-sentence recap. */
  CATCHUP_HEADLINE_MODEL: 'catchup.headline_model',
  /**
   * Local (Eastern, server-clock) "HH:MM" at which CatchupWarmMonitor pre-generates
   * yesterday's Daily Catch-Up (incl. the AI headline) so the first viewer of the
   * morning doesn't wait for the model. After this time, if the day isn't cached
   * yet, the next monitor tick warms it. Admin-tunable without a restart.
   */
  CATCHUP_WARM_TIME: 'catchup.warm_time',
} as const;

/**
 * Selectable whisper.cpp models surfaced in admin Settings.
 *   - `base`          — fast, lower accuracy. Historical default; kept as the safe fallback.
 *   - `large-v3`      — highest accuracy, slowest.
 *   - `large-v3-turbo`— near-large-v3 accuracy at a fraction of the runtime. RECOMMENDED.
 * The value stored is the bare model name; the model file must exist at
 * runtime/whisper-models/ggml-<name>.bin (see runtime download notes in docs/README.md).
 */
export const TRANSCRIPTION_MODEL_OPTIONS = [
  { value: 'base',            label: 'base — fast, lower accuracy (fallback default)' },
  { value: 'large-v3-turbo',  label: 'large-v3-turbo — recommended (near large-v3 accuracy, much faster)' },
  { value: 'large-v3',        label: 'large-v3 — highest accuracy, slowest' },
] as const;

export const SETTING_DEFAULTS = {
  [SETTING_KEYS.HANDOFF_STALE_THRESHOLD_DAYS]: 3,
  [SETTING_KEYS.HANDOFF_MONITOR_TICK_MINUTES]: 15,

  [SETTING_KEYS.REVIEW_STALE_THRESHOLD_DAYS]: 3,
  [SETTING_KEYS.REVIEW_MONITOR_TICK_MINUTES]: 15,

  // Keep `base` as the fallback so enabling the feature never silently changes
  // transcription behavior until an admin explicitly opts into a bigger model.
  [SETTING_KEYS.TRANSCRIPTION_MODEL]: 'base',
  [SETTING_KEYS.TRANSCRIPTION_WORKERS]: 2,
  [SETTING_KEYS.TRANSCRIPTION_TIMEOUT_MINUTES]: 15,
  [SETTING_KEYS.TRANSCRIPTION_TIMEOUT_LENGTH_AWARE]: false,

  [SETTING_KEYS.CATCHUP_AI_ENABLED]: true,
  [SETTING_KEYS.CATCHUP_HEADLINE_MODEL]: 'claude-haiku-4-5',
  [SETTING_KEYS.CATCHUP_WARM_TIME]: '05:30',
} as const;
