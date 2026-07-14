/**
 * CatchupWarmMonitor — pre-generates the Daily Catch-Up each morning so the
 * first person to open the drawer doesn't wait for the AI headline.
 *
 * The recap is otherwise built lazily on first open (deterministic recap is
 * instant; the headline is a ~1-2s Haiku call). This monitor warms yesterday's
 * recap — including the headline — into `catchup_cache` at a configured local
 * (Eastern, server-clock) time (default 05:30), so every viewer that day reads
 * the cache instantly.
 *
 * Design:
 *   • Ticks every 5 minutes; on each tick, if the current local time is at/after
 *     the configured warm time AND yesterday's recap isn't cached yet, it builds
 *     and caches it. The cache check makes it idempotent — it fires once per day
 *     (and a user who happened to open the drawer earlier already warmed it).
 *   • Resilient to restarts / missed windows: if the process boots at 8am with
 *     nothing cached, the next tick (past the warm time) warms it immediately.
 *   • Transient headline failures aren't cached by buildCatchup(), so the next
 *     tick simply retries.
 *   • Respects the monitor enable toggle (monitor.catchup-warm.enabled) via the
 *     registry, and CATCHUP_AI_ENABLED via buildCatchup() (warming still caches
 *     the deterministic recap when the headline is off).
 */

import type { Monitor } from '@/lib/services/monitor-registry';
import { buildCatchup, defaultCatchupDate } from '@/lib/services/catchup-service';
import { getCatchupCache } from '@/lib/store/activity-db';
import { getSetting, SETTING_KEYS, SETTING_DEFAULTS } from '@/lib/store/lpos-settings-store';

/** Parse "HH:MM" → minutes since local midnight; null if malformed. */
function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export class CatchupWarmMonitor implements Monitor {
  readonly name = 'catchup-warm';
  readonly description =
    'Pre-generates the Daily Catch-Up (including the AI headline) each morning so the first viewer does not wait.';
  readonly tickIntervalMs = 5 * 60_000; // 5 min — fine granularity for a once-a-day warm

  async tick(): Promise<void> {
    const warmTime = getSetting<string>(
      SETTING_KEYS.CATCHUP_WARM_TIME,
      SETTING_DEFAULTS[SETTING_KEYS.CATCHUP_WARM_TIME],
    );
    const targetMinutes = parseHHMM(warmTime);
    if (targetMinutes === null) {
      console.warn(`[catchup-warm] invalid warm time '${warmTime}' — skipping`);
      return;
    }

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes(); // server-local (Eastern)
    if (nowMinutes < targetMinutes) return; // warm time not reached yet today

    const date = defaultCatchupDate(); // yesterday, server-local
    if (getCatchupCache(date)) return; // already warmed, or a viewer already opened it

    await buildCatchup(date); // deterministic recap + AI headline, cached
    console.log(`[catchup-warm] pre-generated Daily Catch-Up for ${date}`);
  }
}
