/**
 * Amaran Desktop lighting control service.
 *
 * Connects to the Amaran Desktop app's local WebSocket server, which acts as
 * a bridge between LPOS and Amaran/Aputure lights via Bluetooth.
 *
 * Prerequisites:
 *   - Amaran Desktop must be running on the same machine
 *   - Lights must be paired to Amaran Desktop via Bluetooth first
 *
 * Protocol: JSON over WebSocket on ws://localhost:{port} (default 33782)
 *
 * Verified against live Amaran Desktop v1.0.41 traffic.
 *
 * Request format:
 *   { version: 2, token: '', action: 'snake_case_op', node_id?: '...', args: {} }
 *
 * Response format:
 *   { version: 2, type: 'response', code: 0, message: 'ok', action: '...', data: ... }
 *
 * Event format:
 *   { version: 2, type: 'event', event: 'snake_case_event', node_id: '...', data: ... }
 */

import type { Server as SocketIOServer } from 'socket.io';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AmaranColorMode = 'cct' | 'hsi';

export interface AmaranFixture {
  id:     string;
  name:   string;
  nodeId: string;
}

export interface AmaranFixtureState {
  power:      boolean | null;
  brightness: number | null;   // 0–100
  mode:       AmaranColorMode;
  cct:        number | null;   // Kelvin e.g. 2500–7500
  gm:         number | null;   // Green-magenta shift 0–200 (100 = neutral)
  hue:        number | null;   // 0–360
  saturation: number | null;   // 0–100
}

export interface AmaranStatus {
  connected: boolean;
  fixtures:  AmaranFixture[];
  /** Per-fixture state keyed by nodeId. */
  states:    Record<string, AmaranFixtureState>;
}

// ── Internal request type ─────────────────────────────────────────────────────

interface AmaranRequest {
  version:  2;
  token:    string;
  action:   string;
  node_id?: string;
  args:     Record<string, unknown>;
}

// ── Default fixture state ─────────────────────────────────────────────────────

function defaultFixtureState(): AmaranFixtureState {
  return {
    power:      null,
    brightness: null,
    mode:       'cct',
    cct:        null,
    gm:         null,
    hue:        null,
    saturation: null,
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 5_000;
const DEFAULT_PORT       = 33782;
let   _reqId             = 0;

export class AmaranService {
  private io:             SocketIOServer | null | undefined;
  private ws:             WebSocket | null = null;
  private port:           number           = DEFAULT_PORT;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping:       boolean          = false;

  private _connected: boolean           = false;
  private _fixtures:  AmaranFixture[]   = [];
  private _states:    Record<string, AmaranFixtureState> = {};

  constructor(io?: SocketIOServer | null) {
    this.io = io;
  }

  get status(): AmaranStatus {
    return {
      connected: this._connected,
      fixtures:  [...this._fixtures],
      states:    { ...this._states },
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const { readStudioConfig } = await import('@/lib/store/studio-config-store');
    const cfg = readStudioConfig();
    this.port = cfg.amaran.port;
    if (cfg.amaran.autoConnect) {
      this.connect(this.port);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearReconnect();
    this.closeWs();
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  connect(port?: number): void {
    this.stopping = false;
    if (port) this.port = port;
    this.clearReconnect();
    this.closeWs();

    const url = `ws://127.0.0.1:${this.port}`;
    console.log(`[amaran] connecting → ${url}`);

    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener('open', () => {
        console.log('[amaran] connected');
        this._connected = true;
        this.emitStatus();
        this.discoverAndRefresh().catch(() => {});
      });

      ws.addEventListener('message', (event) => {
        this.handleMessage(String(event.data));
      });

      ws.addEventListener('close', () => {
        console.log('[amaran] disconnected');
        this._connected = false;
        this.emitStatus();
        if (!this.stopping) this.scheduleReconnect();
      });

      ws.addEventListener('error', (err) => {
        console.error('[amaran] WebSocket error:', (err as ErrorEvent).message ?? err);
      });
    } catch (err) {
      console.error('[amaran] failed to create WebSocket:', err);
      if (!this.stopping) this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.stopping = true;
    this.clearReconnect();
    this.closeWs();
    this._connected = false;
    this.emitStatus();
  }

  private closeWs(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopping) this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Discovery & initial state pull ─────────────────────────────────────────

  private async discoverAndRefresh(): Promise<void> {
    try {
      const fixtureRes = await this.sendRequest('get_fixture_list', undefined, {});
      if (fixtureRes.code === 0 && Array.isArray(fixtureRes.data)) {
        this._fixtures = (fixtureRes.data as Array<{ id: string; name: string; node_id: string }>)
          .map(f => ({ id: f.id, name: f.name, nodeId: f.node_id }));
      }

      // Pull state for ALL discovered fixtures in parallel
      await Promise.allSettled(
        this._fixtures.map((f) => this.pullNodeState(f.nodeId)),
      );

      this.emitStatus();
    } catch (err) {
      console.error('[amaran] discovery failed:', err);
    }
  }

  private async pullNodeState(nodeId: string): Promise<void> {
    const [sleepRes, hsiRes, cctRes] = await Promise.allSettled([
      this.sendRequest('get_sleep', nodeId, {}),
      this.sendRequest('get_hsi',   nodeId, {}),
      this.sendRequest('get_cct',   nodeId, {}),
    ]);

    const state: AmaranFixtureState = this._states[nodeId] ?? defaultFixtureState();

    if (sleepRes.status === 'fulfilled' && sleepRes.value.code === 0) {
      state.power = !sleepRes.value.data;
    }

    if (hsiRes.status === 'fulfilled' && hsiRes.value.code === 0) {
      const d = hsiRes.value.data as { hue: number; sat: number; intensity: number };
      state.hue        = d.hue;
      state.saturation = d.sat;
      state.brightness = Math.round((d.intensity / 1000) * 100);
    }

    if (cctRes.status === 'fulfilled' && cctRes.value.code === 0) {
      const d = cctRes.value.data as { cct: number; gm: number; intensity: number };
      state.cct        = d.cct;
      state.gm         = d.gm;
      state.brightness = Math.round((d.intensity / 1000) * 100);
    }

    this._states[nodeId] = state;
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;

      if (msg.type === 'event') {
        this.handleEvent(msg);
        return;
      }

      if (msg.type === 'response' && typeof msg.action === 'string') {
        const resolver = this.pending.get(msg.action);
        if (resolver) {
          this.pending.delete(msg.action);
          resolver({ code: Number(msg.code ?? -1), data: msg.data ?? null });
        }
      }
    } catch {
      // Non-JSON messages — ignore
    }
  }

  private handleEvent(msg: Record<string, unknown>): void {
    const event  = msg.event  as string;
    const nodeId = msg.node_id as string | undefined;

    // We update only the specific fixture that emitted the event.
    // If nodeId is missing, fall back to updating the first known fixture.
    const targetId = nodeId ?? this._fixtures[0]?.nodeId;
    if (!targetId) return;

    const state: AmaranFixtureState = this._states[targetId] ?? defaultFixtureState();

    switch (event) {
      case 'sleep_changed':
        state.power = !msg.data;
        break;

      case 'intensity_changed':
        state.brightness = Math.round((Number(msg.data) / 1000) * 100);
        break;

      case 'cct_changed': {
        const d = msg.data as { cct: number; gm: number; intensity: number };
        state.cct        = d.cct;
        state.gm         = d.gm;
        state.brightness = Math.round((d.intensity / 1000) * 100);
        state.mode       = 'cct';
        break;
      }

      case 'hsi_changed': {
        const d = msg.data as { hue: number; sat: number; intensity: number };
        state.hue        = d.hue;
        state.saturation = d.sat;
        state.brightness = Math.round((d.intensity / 1000) * 100);
        state.mode       = 'hsi';
        break;
      }
    }

    this._states[targetId] = state;
    this.emitStatus();
  }

  // ── Low-level request/response ──────────────────────────────────────────────

  private pending = new Map<string, (res: { code: number; data: unknown }) => void>();

  private sendRequest(
    action: string,
    nodeId: string | undefined,
    args:   Record<string, unknown>,
  ): Promise<{ code: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Amaran Desktop not connected'));
        return;
      }
      const req: AmaranRequest = { version: 2, token: '', action, args };
      if (nodeId) req.node_id = nodeId;

      this.pending.set(action, resolve);

      const timer = setTimeout(() => {
        if (this.pending.has(action)) {
          this.pending.delete(action);
          reject(new Error(`[amaran] timeout waiting for ${action}`));
        }
      }, 5_000);

      try {
        this.ws.send(JSON.stringify({ id: ++_reqId, ...req }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(action);
        reject(err);
      }
    });
  }

  // ── Control API ─────────────────────────────────────────────────────────────

  private resolveNodeId(nodeId?: string): string {
    const id = nodeId ?? this._fixtures[0]?.nodeId;
    if (!id) throw new Error('No fixture connected');
    return id;
  }

  async setPower(on: boolean, nodeId?: string): Promise<void> {
    const id = this.resolveNodeId(nodeId);
    await this.sendRequest('set_sleep', id, { sleep: !on });
    const state = this._states[id] ?? defaultFixtureState();
    state.power = on;
    this._states[id] = state;
    this.emitStatus();
  }

  /** brightness: 0–100 % */
  async setBrightness(pct: number, nodeId?: string): Promise<void> {
    const id       = this.resolveNodeId(nodeId);
    const intensity = Math.round(Math.max(0, Math.min(100, pct)) * 10);
    await this.sendRequest('set_intensity', id, { intensity });
    const state = this._states[id] ?? defaultFixtureState();
    state.brightness = Math.round(pct);
    this._states[id] = state;
    this.emitStatus();
  }

  /** kelvin: typically 2500–7500; gm: 0–200 (100 = neutral) */
  async setCCT(kelvin: number, gm = 100, nodeId?: string): Promise<void> {
    const id  = this.resolveNodeId(nodeId);
    const cct = Math.max(2500, Math.min(7500, Math.round(kelvin)));
    await this.sendRequest('set_cct', id, { cct, gm });
    const state = this._states[id] ?? defaultFixtureState();
    state.cct  = cct;
    state.gm   = gm;
    state.mode = 'cct';
    this._states[id] = state;
    this.emitStatus();
  }

  /** hue: 0–360, saturation: 0–100, brightness: 0–100 % */
  async setHSI(hue: number, saturation: number, brightness: number, nodeId?: string): Promise<void> {
    const id = this.resolveNodeId(nodeId);
    const h  = Math.max(0, Math.min(360, Math.round(hue)));
    const s  = Math.max(0, Math.min(100, Math.round(saturation)));
    const i  = Math.round(Math.max(0, Math.min(100, brightness)) * 10);
    await this.sendRequest('set_hsi', id, { hue: h, sat: s, intensity: i });
    const state = this._states[id] ?? defaultFixtureState();
    state.hue        = h;
    state.saturation = s;
    state.brightness = Math.round(brightness);
    state.mode       = 'hsi';
    this._states[id] = state;
    this.emitStatus();
  }

  async refreshStatus(): Promise<void> {
    if (this._fixtures.length > 0) {
      await Promise.allSettled(this._fixtures.map((f) => this.pullNodeState(f.nodeId)));
      this.emitStatus();
    } else {
      await this.discoverAndRefresh();
    }
  }

  // ── Socket.io broadcast ─────────────────────────────────────────────────────

  private emitStatus(): void {
    this.io?.emit('amaran:status', this.status);
  }
}
