/**
 * MonitorRegistry — pluggable scaffold for "things LPOS should be watching in
 * the background." This is the foundation seam for the planned LPOS-wide
 * "traffic controller" / brain agent (see workspace memory project_brain_agent):
 * each future monitor (handoff staleness, prospect inactivity, dormant
 * deliverables, stale-status tasks, …) is one file in `lib/services/monitors/`
 * that implements `Monitor` and is registered at startup.
 *
 * Why this exists vs. yet another orphan `setInterval`:
 *   • One place to see "what is LPOS watching" (admin Settings → Monitors).
 *   • Per-monitor enable/disable from lpos_settings without a redeploy.
 *   • Error isolation: a thrown tick in one monitor does not affect the others.
 *   • Lifecycle is centralised — single start/stop pair from `initServices`.
 *
 * Each monitor is responsible for its own state persistence; the registry
 * holds only diagnostic in-memory counters (last tick / last error / etc.)
 * exposed via `listStatus()` for the future admin UI.
 *
 * The existing orphan tickers (cloudflare-orphan-reconciler, pipeline-tracker,
 * b2-media-sync, drive-watcher, ep-release, …) are intentionally NOT
 * refactored here — they keep running as-is and can move under the registry
 * opportunistically in later passes. The seam is in place for new work.
 */

import { getSetting } from '@/lib/store/lpos-settings-store';

export interface Monitor {
  /** Stable identifier — used in logs, admin Settings, and the enable/disable
   *  settings key. Kebab-case, no spaces. */
  readonly name: string;
  /** One-line, human-readable purpose — shown in the admin UI. */
  readonly description: string;
  /** Tick cadence in milliseconds. Read once at startup; changing it requires
   *  a server restart. (Per-monitor cadence is intentional — the brain agent
   *  has very different cadences for prospect-inactivity (hours) vs. handoff
   *  staleness (~minutes).) */
  readonly tickIntervalMs: number;
  /** A single tick. Should be idempotent — the registry will retry on its own
   *  cadence if a tick is skipped due to the previous tick still running. */
  tick(): Promise<void>;
}

export interface MonitorStatus {
  name:                string;
  description:         string;
  tickIntervalMs:      number;
  enabled:             boolean;
  running:             boolean;
  lastTickAt:          string | null;
  lastTickDurationMs:  number | null;
  lastError:           string | null;
  lastErrorAt:         string | null;
  tickCount:           number;
}

interface RegisteredMonitor {
  monitor:            Monitor;
  timer:              ReturnType<typeof setInterval> | null;
  running:            boolean;
  lastTickAt:         string | null;
  lastTickDurationMs: number | null;
  lastError:          string | null;
  lastErrorAt:        string | null;
  tickCount:          number;
}

/** Per-monitor enable key in lpos_settings. Default true (monitors run unless
 *  explicitly disabled). */
function enabledKey(name: string): string { return `monitor.${name}.enabled`; }

export function isMonitorEnabled(name: string): boolean {
  return getSetting<boolean>(enabledKey(name), true);
}

export class MonitorRegistry {
  private readonly monitors = new Map<string, RegisteredMonitor>();
  private started = false;

  /** Register a monitor. Safe to call before `startAll()`. After startup, a
   *  registered monitor starts immediately. */
  register(monitor: Monitor): void {
    if (this.monitors.has(monitor.name)) {
      console.warn(`[monitor-registry] duplicate registration for '${monitor.name}' — ignoring`);
      return;
    }
    const entry: RegisteredMonitor = {
      monitor,
      timer:              null,
      running:            false,
      lastTickAt:         null,
      lastTickDurationMs: null,
      lastError:          null,
      lastErrorAt:        null,
      tickCount:          0,
    };
    this.monitors.set(monitor.name, entry);
    if (this.started) this.spinUp(entry);
  }

  /** Start every registered monitor. Idempotent — calling again is a no-op. */
  startAll(): void {
    if (this.started) return;
    this.started = true;
    for (const entry of this.monitors.values()) this.spinUp(entry);
  }

  /** Stop every registered monitor. Cleared timers; in-flight ticks are
   *  allowed to finish (no cancellation token by design — monitor ticks
   *  should be short and idempotent). */
  stopAll(): void {
    this.started = false;
    for (const entry of this.monitors.values()) {
      if (entry.timer) { clearInterval(entry.timer); entry.timer = null; }
    }
  }

  /** Run a single monitor's tick immediately, outside its normal cadence.
   *  Used by manual "Run now" admin actions (future UI) and tests. */
  async runOnce(name: string): Promise<void> {
    const entry = this.monitors.get(name);
    if (!entry) throw new Error(`Unknown monitor: ${name}`);
    await this.runTick(entry);
  }

  /** Diagnostic snapshot — for the admin Settings page. */
  listStatus(): MonitorStatus[] {
    return [...this.monitors.values()].map((e) => ({
      name:               e.monitor.name,
      description:        e.monitor.description,
      tickIntervalMs:     e.monitor.tickIntervalMs,
      enabled:            isMonitorEnabled(e.monitor.name),
      running:            e.running,
      lastTickAt:         e.lastTickAt,
      lastTickDurationMs: e.lastTickDurationMs,
      lastError:          e.lastError,
      lastErrorAt:        e.lastErrorAt,
      tickCount:          e.tickCount,
    }));
  }

  // ── internals ──────────────────────────────────────────────────────────

  private spinUp(entry: RegisteredMonitor): void {
    if (entry.timer) return;
    // Stagger the first tick by 30s so we don't slam the DB at startup if many
    // monitors are registered.
    setTimeout(() => { void this.runTick(entry); }, 30_000);
    entry.timer = setInterval(() => { void this.runTick(entry); }, entry.monitor.tickIntervalMs);
  }

  private async runTick(entry: RegisteredMonitor): Promise<void> {
    // Skip when admin has disabled this monitor.
    if (!isMonitorEnabled(entry.monitor.name)) return;
    // Skip if previous tick is still in flight — prevents pile-up on slow ticks.
    if (entry.running) {
      console.warn(`[monitor-registry] ${entry.monitor.name}: skipping tick — previous still running`);
      return;
    }
    entry.running = true;
    const startedAt = Date.now();
    try {
      await entry.monitor.tick();
      entry.lastTickAt         = new Date(startedAt).toISOString();
      entry.lastTickDurationMs = Date.now() - startedAt;
      entry.tickCount         += 1;
      // Successful tick clears the last-error so the admin UI doesn't show a
      // stale red badge after the issue is resolved.
      entry.lastError   = null;
      entry.lastErrorAt = null;
    } catch (err) {
      entry.lastError   = err instanceof Error ? err.message : String(err);
      entry.lastErrorAt = new Date().toISOString();
      entry.lastTickAt  = entry.lastErrorAt;
      console.error(`[monitor-registry] ${entry.monitor.name} tick failed:`, err);
    } finally {
      entry.running = false;
    }
  }
}

// ── Singleton helpers (matches the rest of lib/services/container.ts) ─────

declare global {
  // eslint-disable-next-line no-var
  var __lpos_monitorRegistry: MonitorRegistry | undefined;
}

export function getMonitorRegistry(): MonitorRegistry {
  if (globalThis.__lpos_monitorRegistry) return globalThis.__lpos_monitorRegistry;
  globalThis.__lpos_monitorRegistry = new MonitorRegistry();
  return globalThis.__lpos_monitorRegistry;
}
