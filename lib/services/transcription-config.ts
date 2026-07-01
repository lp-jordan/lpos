/**
 * Transcription configuration resolver.
 *
 * Central place that turns the SQLite-backed `lpos_settings` knobs (and env-var
 * fallbacks) into concrete values the transcripter service + media-processor
 * consume. Keeping this in one module means validation (allowed models, clamped
 * worker counts, timeout floors) is not duplicated across callers.
 *
 * Precedence for each value: admin Setting → env var → hard default.
 * `base` remains the fallback model everywhere so the feature is opt-in.
 */

import {
  getSetting,
  SETTING_KEYS,
  SETTING_DEFAULTS,
  TRANSCRIPTION_MODEL_OPTIONS,
} from '@/lib/store/lpos-settings-store';

const ALLOWED_MODELS = new Set<string>(TRANSCRIPTION_MODEL_OPTIONS.map((o) => o.value));

/** Bare whisper.cpp model name (e.g. "base", "large-v3-turbo"). */
export function getTranscriptionModel(): string {
  // Env var still wins for operators who pin a model outside the UI.
  const envModel = process.env.LPOS_WHISPER_MODEL?.trim();
  if (envModel) return envModel;

  const stored = getSetting<string>(
    SETTING_KEYS.TRANSCRIPTION_MODEL,
    SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_MODEL],
  );
  // Guard against a stale/typo'd value silently selecting a missing model dir.
  return ALLOWED_MODELS.has(stored)
    ? stored
    : SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_MODEL];
}

/**
 * Number of concurrent whisper.cpp workers. Big models (large-v3*) contend for
 * the single Metal GPU, so 1 is the recommended value for them — the admin sets
 * that explicitly; we only clamp to a sane range here.
 */
export function getTranscriptionWorkers(): number {
  const envWorkers = process.env.LPOS_TRANSCRIPTION_WORKERS
    ? parseInt(process.env.LPOS_TRANSCRIPTION_WORKERS, 10)
    : NaN;
  const stored = Number.isFinite(envWorkers)
    ? envWorkers
    : getSetting<number>(
        SETTING_KEYS.TRANSCRIPTION_WORKERS,
        SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_WORKERS],
      );
  const n = Math.floor(Number(stored));
  if (!Number.isFinite(n)) return SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_WORKERS];
  // Clamp 1..8 — more than 8 concurrent whisper procs on one machine is never useful.
  return Math.min(8, Math.max(1, n));
}

/** Configured base/floor timeout in minutes. */
function getTimeoutMinutes(): number {
  const stored = getSetting<number>(
    SETTING_KEYS.TRANSCRIPTION_TIMEOUT_MINUTES,
    SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_TIMEOUT_MINUTES],
  );
  const n = Math.floor(Number(stored));
  if (!Number.isFinite(n) || n < 1) return SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_TIMEOUT_MINUTES];
  return n;
}

function isLengthAware(): boolean {
  return getSetting<boolean>(
    SETTING_KEYS.TRANSCRIPTION_TIMEOUT_LENGTH_AWARE,
    SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_TIMEOUT_LENGTH_AWARE],
  ) === true;
}

/**
 * Resolve the per-job timeout in milliseconds.
 *
 * The historical fixed 15-min cap trips on long (>30–45 min) videos, especially
 * with large-v3 which runs slower than real time. When length-aware mode is on
 * and a media duration is known, the timeout scales with duration so long files
 * get proportionally more headroom; the configured minutes act as a floor.
 *
 * @param mediaDurationSec optional known duration of the source media, seconds.
 */
export function getTranscriptionTimeoutMs(mediaDurationSec?: number): number {
  const floorMs = getTimeoutMinutes() * 60_000;

  if (!isLengthAware() || !mediaDurationSec || !Number.isFinite(mediaDurationSec) || mediaDurationSec <= 0) {
    return floorMs;
  }

  // Budget ~4x real-time (large-v3 on Metal is usually well under this) plus a
  // 5-minute fixed overhead for audio extraction + model load. Never below the
  // configured floor, and capped at 6 hours as a hard safety ceiling.
  const REALTIME_MULTIPLIER = 4;
  const FIXED_OVERHEAD_MS = 5 * 60_000;
  const HARD_CEILING_MS = 6 * 60 * 60_000;

  const scaledMs = mediaDurationSec * 1000 * REALTIME_MULTIPLIER + FIXED_OVERHEAD_MS;
  return Math.min(HARD_CEILING_MS, Math.max(floorMs, scaledMs));
}
