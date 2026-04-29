/**
 * WLED lighting control service.
 *
 * Controls a WLED device over its local HTTP JSON API.
 * WLED must be on the same network and reachable by IP.
 *
 * API docs: https://kno.wled.ge/interfaces/json-api/
 *
 * Endpoints used:
 *   GET  http://{ip}/json         — full state + effects list
 *   POST http://{ip}/json/state   — set state (on, bri, seg params)
 *   GET  http://{ip}/json/presets — saved user presets
 *
 * CCT mapping: WLED uses 0–255 (0 = cold, 255 = warm).
 *              This service maps to/from 0–100 for the UI.
 *
 * Brightness mapping: WLED uses 0–255; mapped to/from 0–100.
 */

import type { Server as SocketIOServer } from 'socket.io';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WledEffect {
  id:   number;
  name: string;
}

export interface WledPreset {
  id:   number;
  name: string;
}

export interface WledStatus {
  reachable:  boolean;
  power:      boolean;
  brightness: number;    // 0–100
  cct:        number;    // 0–100 (0 = warm/amber, 100 = cold/blue)
  effectId:   number;
  effectName: string;
  effects:    WledEffect[];
  presets:    WledPreset[];
}

// ── Internal WLED JSON shape (partial) ────────────────────────────────────────

interface WledJsonResponse {
  state: {
    on:  boolean;
    bri: number;        // 0–255
    seg: Array<{
      cct?: number;     // 0–255
      fx?:  number;     // effect id
    }>;
    ps?: number;        // active preset id
  };
  info: {
    name: string;
    ver:  string;
  };
  effects:  string[];   // indexed by effect id
}

// ── Service ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000; // client-side WledPanel polls at 15 s; server poll just keeps the status fresh

export class WledService {
  private io:          SocketIOServer | null | undefined;
  private ip:          string = '';
  private pollTimer:   ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private effectCache: WledEffect[] = [];
  private presetCache: WledPreset[] = [];

  private _status: WledStatus = {
    reachable:  false,
    power:      false,
    brightness: 0,
    cct:        50,
    effectId:   0,
    effectName: 'Solid',
    effects:    [],
    presets:    [],
  };

  constructor(io?: SocketIOServer | null) {
    this.io = io;
  }

  get status(): WledStatus {
    return {
      ...this._status,
      effects: [...this._status.effects],
      presets: [...this._status.presets],
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const { readStudioConfig } = await import('@/lib/store/studio-config-store');
    this.ip = readStudioConfig().wled.ip;
    if (this.ip) {
      await this.poll();
      this.startPolling();
    }
  }

  stop(): void {
    this.stopPolling();
  }

  /** Called from config PATCH route so service picks up a new IP without restart. */
  reconfigure(ip: string): void {
    this.ip = ip;
    this.effectCache = [];
    this.presetCache = [];
    this._status.reachable = false;
    this.stopPolling();
    if (ip) {
      void this.poll();
      this.startPolling();
    }
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  private startPolling(): void {
    this.pollTimer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  async refreshStatus(): Promise<void> {
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (!this.ip || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const res = await fetch(`http://${this.ip}/json`, { signal: AbortSignal.timeout(4_000) });
      if (!res.ok) { this.setUnreachable(); return; }

      const data = await res.json() as WledJsonResponse;

      // Cache effects list on first fetch or when it changes
      if (data.effects && data.effects.length > 0 && this.effectCache.length === 0) {
        this.effectCache = data.effects.map((name, id) => ({ id, name }));
      }

      // Fetch presets if not cached
      if (this.presetCache.length === 0) {
        void this.fetchPresets();
      }

      const seg = data.state.seg?.[0] ?? {};
      const effectId = seg.fx ?? 0;
      const effectName = this.effectCache.find((e) => e.id === effectId)?.name ?? 'Unknown';

      this._status = {
        reachable:  true,
        power:      data.state.on,
        brightness: Math.round(((data.state.bri ?? 0) / 255) * 100),
        cct:        Math.round(((seg.cct ?? 128) / 255) * 100),
        effectId,
        effectName,
        effects:    this.effectCache,
        presets:    this.presetCache,
      };

      this.emitStatus();
    } catch {
      this.setUnreachable();
    } finally {
      this.pollInFlight = false;
    }
  }

  private setUnreachable(): void {
    if (this._status.reachable) {
      this._status.reachable = false;
      this.emitStatus();
    }
  }

  private async fetchPresets(): Promise<void> {
    try {
      const res = await fetch(`http://${this.ip}/json/presets`, { signal: AbortSignal.timeout(4_000) });
      if (!res.ok) return;
      const data = await res.json() as Record<string, { n?: string }>;
      this.presetCache = Object.entries(data)
        .filter(([id]) => id !== '0')  // id 0 = "no preset"
        .map(([id, preset]) => ({ id: Number(id), name: preset.n ?? `Preset ${id}` }))
        .sort((a, b) => a.id - b.id);
      this._status.presets = this.presetCache;
    } catch { /* non-critical */ }
  }

  // ── Control API ─────────────────────────────────────────────────────────────

  async setPower(on: boolean): Promise<void> {
    await this.postState({ on });
    this._status.power = on;
    this.emitStatus();
  }

  /** brightness: 0–100 % */
  async setBrightness(pct: number): Promise<void> {
    const bri = Math.round(Math.max(0, Math.min(100, pct)) * 2.55);
    await this.postState({ bri });
    this._status.brightness = Math.round(pct);
    this.emitStatus();
  }

  /** cct: 0–100 (0 = warm/amber, 100 = cold/blue) */
  async setCct(pct: number): Promise<void> {
    const cct = Math.round(Math.max(0, Math.min(100, pct)) * 2.55);
    await this.postState({ seg: [{ cct }] });
    this._status.cct = Math.round(pct);
    this.emitStatus();
  }

  async setEffect(id: number): Promise<void> {
    await this.postState({ seg: [{ fx: id }] });
    this._status.effectId   = id;
    this._status.effectName = this.effectCache.find((e) => e.id === id)?.name ?? 'Unknown';
    this.emitStatus();
  }

  async applyPreset(id: number): Promise<void> {
    await this.postState({ ps: id });
    // Poll after a short delay to pick up the state that the preset sets
    setTimeout(() => { void this.poll(); }, 500);
  }

  // ── Low-level fetch ─────────────────────────────────────────────────────────

  private async postState(body: Record<string, unknown>): Promise<void> {
    if (!this.ip) throw new Error('WLED IP not configured');
    const res = await fetch(`http://${this.ip}/json/state`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(4_000),
    });
    if (!res.ok) throw new Error(`WLED responded ${res.status}`);
    this._status.reachable = true;
  }

  // ── Socket.io broadcast ─────────────────────────────────────────────────────

  private emitStatus(): void {
    this.io?.emit('wled:status', this.status);
  }
}
