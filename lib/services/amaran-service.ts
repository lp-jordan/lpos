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
  id:      string;
  name:    string;
  nodeId:  string;
}

export interface AmaranStatus {
  connected:  boolean;
  power:      boolean | null;  // true = on (not sleeping)
  brightness: number | null;   // 0–100 (maps to intensity 0–1000)
  mode:       AmaranColorMode;
  cct:        number | null;   // Kelvin e.g. 2500–7500
  gm:         number | null;   // Green-magenta shift 0–200 (100 = neutral)
  hue:        number | null;   // 0–360
  saturation: number | null;   // 0–100
  fixtures:   AmaranFixture[];
  activeNodeId: string | null;
}

// ── Internal request type ─────────────────────────────────────────────────────

interface AmaranRequest {
  version:  2;
  token:    string;
  action:   string;
  node_id?: string;
  args:     Record<string, unknown>;
}

// ── Service ───────────────────────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 5_000;
const DEFAULT_PORT       = 33782;
let   _reqId             = 0;

export class AmaranService {
  private io:              SocketIOServer | null | undefined;
  private ws:              WebSocket | null = null;
  private port:            number           = DEFAULT_PORT;
  private reconnectTimer:  ReturnType<typeof setTimeout> | null = null;
  private stopping:        boolean          = false;

  private _status: AmaranStatus = {
    connected:    false,
    power:        null,
    brightness:   null,
    mode:         'cct',
    cct:          null,
    gm:           null,
    hue:          null,
    saturation:   null,
    fixtures:     [],
    activeNodeId: null,
  };

  constructor(io?: SocketIOServer | null) {
    this.io = io;
  }

  get status(): AmaranStatus {
    return { ...this._status, fixtures: [...this._status.fixtures] };
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
        this._status.connected = true;
        this.emitStatus();
        // Discover fixtures then pull initial state
        this.discoverAndRefresh().catch(() => {});
      });

      ws.addEventListener('message', (event) => {
        this.handleMessage(String(event.data));
      });

      ws.addEventListener('close', () => {
        console.log('[amaran] disconnected');
        this._status.connected = false;
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
    this._status.connected = false;
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
      // Get physical fixtures (excludes virtual groups like "All")
      const fixtureRes = await this.sendRequest('get_fixture_list', undefined, {});
      if (fixtureRes.code === 0 && Array.isArray(fixtureRes.data)) {
        this._status.fixtures = (fixtureRes.data as Array<{ id: string; name: string; node_id: string }>)
          .map(f => ({ id: f.id, name: f.name, nodeId: f.node_id }));
        if (!this._status.activeNodeId && this._status.fixtures.length > 0) {
          this._status.activeNodeId = this._status.fixtures[0].nodeId;
        }
      }
      if (this._status.activeNodeId) {
        await this.pullNodeState(this._status.activeNodeId);
      }
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

    if (sleepRes.status === 'fulfilled' && sleepRes.value.code === 0) {
      // sleep: true = sleeping (off), false = awake (on)
      this._status.power = !sleepRes.value.data;
    }

    if (hsiRes.status === 'fulfilled' && hsiRes.value.code === 0) {
      const d = hsiRes.value.data as { hue: number; sat: number; intensity: number };
      this._status.hue        = d.hue;
      this._status.saturation = d.sat;
      this._status.brightness = Math.round((d.intensity / 1000) * 100);
    }

    if (cctRes.status === 'fulfilled' && cctRes.value.code === 0) {
      const d = cctRes.value.data as { cct: number; gm: number; intensity: number };
      this._status.cct        = d.cct;
      this._status.gm         = d.gm;
      this._status.brightness = Math.round((d.intensity / 1000) * 100);
    }
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;

      if (msg.type === 'event') {
        this.handleEvent(msg);
        return;
      }

      // Response: resolve the pending promise keyed by action name.
      // Amaran Desktop does not echo the request id in responses, so we match
      // by action. Only one in-flight request per action is expected.
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
    const event = msg.event as string;

    switch (event) {
      case 'sleep_changed':
        // sleep: true = off, false = on
        this._status.power = !msg.data;
        break;

      case 'intensity_changed':
        this._status.brightness = Math.round((Number(msg.data) / 1000) * 100);
        break;

      case 'cct_changed': {
        const d = msg.data as { cct: number; gm: number; intensity: number };
        this._status.cct        = d.cct;
        this._status.gm         = d.gm;
        this._status.brightness = Math.round((d.intensity / 1000) * 100);
        this._status.mode       = 'cct';
        break;
      }

      case 'hsi_changed': {
        const d = msg.data as { hue: number; sat: number; intensity: number };
        this._status.hue        = d.hue;
        this._status.saturation = d.sat;
        this._status.brightness = Math.round((d.intensity / 1000) * 100);
        this._status.mode       = 'hsi';
        break;
      }
    }

    this.emitStatus();
  }

  // ── Low-level request/response ──────────────────────────────────────────────

  // Keyed by action name — one pending request per action at a time.
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

      // Clean up if no response arrives in 5 s
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

  private get nodeId(): string | null {
    return this._status.activeNodeId;
  }

  async setPower(on: boolean): Promise<void> {
    if (!this.nodeId) throw new Error('No fixture connected');
    await this.sendRequest('set_sleep', this.nodeId, { sleep: !on });
    this._status.power = on;
    this.emitStatus();
  }

  /** brightness: 0–100 % */
  async setBrightness(pct: number): Promise<void> {
    if (!this.nodeId) throw new Error('No fixture connected');
    const intensity = Math.round(Math.max(0, Math.min(100, pct)) * 10); // 0-100% → 0-1000
    await this.sendRequest('set_intensity', this.nodeId, { intensity });
    this._status.brightness = Math.round(pct);
    this.emitStatus();
  }

  /** kelvin: typically 2500–7500 for T2c; gm: 0–200 (100 = neutral) */
  async setCCT(kelvin: number, gm = 100): Promise<void> {
    if (!this.nodeId) throw new Error('No fixture connected');
    const cct = Math.max(2500, Math.min(7500, Math.round(kelvin)));
    await this.sendRequest('set_cct', this.nodeId, { cct, gm });
    this._status.cct  = cct;
    this._status.gm   = gm;
    this._status.mode = 'cct';
    this.emitStatus();
  }

  /** hue: 0–360, saturation: 0–100, brightness: 0–100 % */
  async setHSI(hue: number, saturation: number, brightness: number): Promise<void> {
    if (!this.nodeId) throw new Error('No fixture connected');
    const h = Math.max(0, Math.min(360, Math.round(hue)));
    const s = Math.max(0, Math.min(100, Math.round(saturation)));
    const i = Math.round(Math.max(0, Math.min(100, brightness)) * 10); // 0-100% → 0-1000
    await this.sendRequest('set_hsi', this.nodeId, { hue: h, sat: s, intensity: i });
    this._status.hue        = h;
    this._status.saturation = s;
    this._status.brightness = Math.round(brightness);
    this._status.mode       = 'hsi';
    this.emitStatus();
  }

  async refreshStatus(): Promise<void> {
    if (this._status.activeNodeId) {
      await this.pullNodeState(this._status.activeNodeId);
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
