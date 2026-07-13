import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server as SocketIOServer } from 'socket.io';
import type { ServiceRegistry } from './registry';
import {
  getAvailableApiList as getLegacyApiList,
  getAvailableIsoSpeedRate as getLegacyIsoOptions,
  getAvailableWhiteBalance as getLegacyWhiteBalanceOptions,
  getCameraEvent as getLegacyCameraEvent,
  setIsoSpeedRate as setLegacyIso,
  setWhiteBalance as setLegacyWhiteBalance,
  sonyBinaryToMjpeg,
  sonyRpc,
  startLiveview as startLegacyLiveview,
  startMovieRec as startLegacyMovieRec,
  stopLiveview as stopLegacyLiveview,
  stopMovieRec as stopLegacyMovieRec,
  MJPEG_BOUNDARY,
  type CameraStatus,
} from './sony-camera';
import {
  readStudioConfig,
  patchStudioConfig,
  getArmedCameras,
  type CameraConfig,
  type CameraProviderKind,
  type SonyCameraModel,
  type SonyCameraDevice,
} from '@/lib/store/studio-config-store';

/** Liveness + live state for one rostered camera. */
export interface CameraHealth {
  id: string;
  label: string;
  host: string;
  model: SonyCameraModel;
  armed: boolean;
  online: boolean;                    // answers on the network
  recording: boolean;                 // only read for armed cameras
  batteryPercent: number | null;
  remainingSeconds: number | null;
  error?: string;                     // reachable, but the SDK call failed
  checkedAt: string;
}

// Liveness is a cheap TCP connect (no SDK session) so every camera can be polled
// cheaply. Bodies don't all answer on the same port: Access-Authenticated FX6/FX3
// take the SDK over SSH (22); some FX6 firmware also exposes a web service (80);
// non-auth bodies use PTP/IP (15740). The FX3 answers on 22 ONLY — probing just 80
// (as the original code did) marked it offline despite a working SSH/SDK session, so
// its status never showed. Reachable = any candidate port open.
const REACHABILITY_PORTS = [22, 80, 15740];
const REACHABILITY_TIMEOUT_MS = 2_000;

function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function probeReachable(host: string, timeoutMs = REACHABILITY_TIMEOUT_MS): Promise<boolean> {
  const results = await Promise.all(REACHABILITY_PORTS.map((p) => probePort(host, p, timeoutMs)));
  return results.some(Boolean);
}

/** Outcome of a single camera in a coordinated record/stop roll. */
export interface CameraRollResult {
  id: string;
  label: string;
  host: string;
  model: SonyCameraModel;
  ok: boolean;          // command confirmed (recording started / stopped) within the timeout
  error?: string;       // populated when ok === false
  // What the camera last reported, not what we asked it to do. `null` when the
  // state could not be read. Callers must use this — never a command outcome — to
  // decide whether a camera is actually rolling.
  recording: boolean | null;
}

// How long to wait for a camera to confirm it actually started/stopped rolling.
const ROLL_CONFIRM_TIMEOUT_MS = 5_000;
const ROLL_CONFIRM_POLL_MS = 400;

/** Per-camera outcome of a timecode soft-jam. */
export interface TimecodeJamResult {
  id: string;
  label: string;
  host: string;
  ok: boolean;
  timecode?: string;   // read-back preset on success
  error?: string;
}

export interface CameraConnectResult {
  provider: CameraProviderKind;
  model: SonyCameraModel;
  capabilities: string[];
  whiteBalanceOptions: string[];
  isoOptions: string[];
  status: CameraStatus | null;
}

export interface DiscoveredCamera {
  name: string;
  model: SonyCameraModel;
  host: string;
  connectionType: string;
  id: string;
  macAddress: string;
  sshSupported: boolean;
}

interface CameraBridgeHealth {
  ok?: boolean;
  version?: string;
  provider?: string;
}

interface CameraStreamResponse {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

interface CameraProvider {
  getAvailableApiList(config: CameraConfig): Promise<string[]>;
  getCameraEvent(config: CameraConfig): Promise<CameraStatus>;
  startMovieRec(config: CameraConfig): Promise<void>;
  stopMovieRec(config: CameraConfig): Promise<void>;
  getAvailableWhiteBalance(config: CameraConfig): Promise<string[]>;
  setWhiteBalance(config: CameraConfig, mode: string): Promise<void>;
  getAvailableIsoSpeedRate(config: CameraConfig): Promise<string[]>;
  setIsoSpeedRate(config: CameraConfig, iso: string): Promise<void>;
  openLiveview(config: CameraConfig): Promise<CameraStreamResponse>;
  callMethod(config: CameraConfig, method: string, params?: unknown[]): Promise<unknown>;
}

function resolveCameraConfig(override?: Partial<CameraConfig>): CameraConfig {
  const stored = readStudioConfig().camera;
  const host = (override?.host ?? override?.ip ?? stored.host ?? stored.ip ?? '').trim();

  return {
    ...stored,
    ...override,
    host,
    ip: host,
    port: override?.port ?? stored.port,
    sdkBridge: {
      ...stored.sdkBridge,
      ...(override?.sdkBridge ?? {}),
    },
  };
}

async function readJsonError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string; message?: string };
    return body.error ?? body.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

class SonyCameraApiProvider implements CameraProvider {
  async getAvailableApiList(config: CameraConfig): Promise<string[]> {
    return getLegacyApiList(config.host, config.port);
  }

  async getCameraEvent(config: CameraConfig): Promise<CameraStatus> {
    return getLegacyCameraEvent(config.host, config.port, false);
  }

  async startMovieRec(config: CameraConfig): Promise<void> {
    await startLegacyMovieRec(config.host, config.port);
  }

  async stopMovieRec(config: CameraConfig): Promise<void> {
    await stopLegacyMovieRec(config.host, config.port);
  }

  async getAvailableWhiteBalance(config: CameraConfig): Promise<string[]> {
    return getLegacyWhiteBalanceOptions(config.host, config.port);
  }

  async setWhiteBalance(config: CameraConfig, mode: string): Promise<void> {
    await setLegacyWhiteBalance(config.host, config.port, mode);
  }

  async getAvailableIsoSpeedRate(config: CameraConfig): Promise<string[]> {
    return getLegacyIsoOptions(config.host, config.port);
  }

  async setIsoSpeedRate(config: CameraConfig, iso: string): Promise<void> {
    await setLegacyIso(config.host, config.port, iso);
  }

  async openLiveview(config: CameraConfig): Promise<CameraStreamResponse> {
    await stopLegacyLiveview(config.host, config.port).catch(() => { /* best effort */ });
    const liveviewUrl = await startLegacyLiveview(config.host, config.port);
    const response = await fetch(liveviewUrl);

    if (!response.ok || !response.body) {
      throw new Error('Failed to open liveview stream');
    }

    return {
      body: sonyBinaryToMjpeg(response.body),
      contentType: `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    };
  }

  async callMethod(config: CameraConfig, method: string, params: unknown[] = []): Promise<unknown> {
    return sonyRpc(config.host, config.port, method, params);
  }
}

class SonySdkBridgeProvider implements CameraProvider {
  constructor(private readonly service: CameraControlService) {}

  private async requestJson<T>(config: CameraConfig, path: string, init?: RequestInit): Promise<T> {
    await this.service.ensureSdkBridgeReady(config);
    const url = new URL(path, config.sdkBridge.baseUrl.endsWith('/') ? config.sdkBridge.baseUrl : `${config.sdkBridge.baseUrl}/`);
    const response = await fetch(url, init);

    if (!response.ok) {
      throw new Error(await readJsonError(response));
    }

    return response.json() as Promise<T>;
  }

  private bridgeBody(config: CameraConfig, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      host: config.host,
      model: config.model,
      username: config.username,
      password: config.password,
      fingerprint: config.fingerprint,
      mac: config.mac,
      ...extra,
    });
  }

  async getAvailableApiList(config: CameraConfig): Promise<string[]> {
    const response = await this.requestJson<{ capabilities?: string[] }>(
      config,
      'camera/capabilities',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.bridgeBody(config),
      },
    );
    return response.capabilities ?? [];
  }

  async getCameraEvent(config: CameraConfig): Promise<CameraStatus> {
    return this.requestJson<CameraStatus>(
      config,
      `camera/status?host=${encodeURIComponent(config.host)}&model=${encodeURIComponent(config.model)}&username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}&fingerprint=${encodeURIComponent(config.fingerprint)}&mac=${encodeURIComponent(config.mac)}`,
    );
  }

  async startMovieRec(config: CameraConfig): Promise<void> {
    await this.requestJson(
      config,
      'camera/record/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.bridgeBody(config),
      },
    );
  }

  // Software "soft jam": Free-Run + Preset + write the timecode. Returns the read-back
  // preset (SDK-only — the legacy provider has no timecode support). Not frame-accurate.
  async jamTimecode(config: CameraConfig, timecode: string, dropFrame: boolean): Promise<string> {
    const res = await this.requestJson<{ timecode?: string }>(
      config,
      'camera/timecode',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.bridgeBody(config, { timecode, dropFrame }),
      },
    );
    return res.timecode ?? '';
  }

  async getTimecode(config: CameraConfig): Promise<string> {
    const res = await this.requestJson<{ timecode?: string }>(
      config,
      `camera/timecode?host=${encodeURIComponent(config.host)}&model=${encodeURIComponent(config.model)}&username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}&fingerprint=${encodeURIComponent(config.fingerprint)}&mac=${encodeURIComponent(config.mac)}`,
    );
    return res.timecode ?? '';
  }

  async stopMovieRec(config: CameraConfig): Promise<void> {
    await this.requestJson(
      config,
      'camera/record/stop',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.bridgeBody(config),
      },
    );
  }

  async getAvailableWhiteBalance(config: CameraConfig): Promise<string[]> {
    const response = await this.requestJson<{ options?: string[] }>(
      config,
      `camera/settings/white-balance/options?host=${encodeURIComponent(config.host)}&model=${encodeURIComponent(config.model)}&username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}&fingerprint=${encodeURIComponent(config.fingerprint)}&mac=${encodeURIComponent(config.mac)}`,
    );
    return response.options ?? [];
  }

  async setWhiteBalance(config: CameraConfig, mode: string): Promise<void> {
    await this.requestJson(
      config,
      'camera/settings/white-balance',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.bridgeBody(config, { mode }),
      },
    );
  }

  async getAvailableIsoSpeedRate(config: CameraConfig): Promise<string[]> {
    const response = await this.requestJson<{ options?: string[] }>(
      config,
      `camera/settings/iso/options?host=${encodeURIComponent(config.host)}&model=${encodeURIComponent(config.model)}&username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}&fingerprint=${encodeURIComponent(config.fingerprint)}&mac=${encodeURIComponent(config.mac)}`,
    );
    return response.options ?? [];
  }

  async setIsoSpeedRate(config: CameraConfig, iso: string): Promise<void> {
    await this.requestJson(
      config,
      'camera/settings/iso',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.bridgeBody(config, { iso }),
      },
    );
  }

  async openLiveview(config: CameraConfig): Promise<CameraStreamResponse> {
    await this.service.ensureSdkBridgeReady(config);
    const url = new URL('camera/liveview', config.sdkBridge.baseUrl.endsWith('/') ? config.sdkBridge.baseUrl : `${config.sdkBridge.baseUrl}/`);
    url.searchParams.set('host', config.host);
    url.searchParams.set('model', config.model);
    url.searchParams.set('username', config.username);
    url.searchParams.set('password', config.password);
    url.searchParams.set('fingerprint', config.fingerprint);
    url.searchParams.set('mac', config.mac);

    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(await readJsonError(response));
    }

    return {
      body: response.body,
      contentType: response.headers.get('Content-Type') ?? 'multipart/x-mixed-replace',
    };
  }

  async callMethod(config: CameraConfig, method: string, params: unknown[] = []): Promise<unknown> {
    return this.requestJson(
      config,
      'camera/rpc',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.bridgeBody(config, { method, params }),
      },
    );
  }
}

export class CameraControlService {
  private sdkBridgeProcess: ChildProcessWithoutNullStreams | null = null;
  private readonly legacyProvider = new SonyCameraApiProvider();
  private readonly sdkProvider = new SonySdkBridgeProvider(this);

  // Per-host roll coordination. Every start/stop stamps a monotonically increasing
  // sequence for its camera's host and records it as that host's latest intent. A
  // queued roll that is no longer the latest intent when its turn comes is dropped
  // instead of dispatched — so a stale START (e.g. one that blocked ~45s on a
  // powered-off body) can never fire a REC toggle after a newer STOP. That exact
  // race left an FX3 rolling: its take-start blocked while the body was off, the
  // operator pressed stop, the body came back, and the stale start finally toggled
  // it on *after* the stop. Rolls to the same host are also serialized so start and
  // stop can't interleave mid-toggle.
  private rollSeq = 0;
  private readonly latestRollSeq = new Map<string, number>();
  private readonly rollChain = new Map<string, Promise<unknown>>();

  constructor(
    private readonly io?: SocketIOServer,
    private readonly registry?: ServiceRegistry,
  ) {}

  async start(): Promise<void> {
    this.registry?.register('camera-control', 'Camera Control');

    const config = readStudioConfig().camera;
    if (config.provider === 'sony-sdk') {
      try {
        await this.ensureSdkBridgeReady(config);
      } catch (error) {
        const message = (error as Error).message;
        this.registry?.update('camera-control', 'error', message);
        console.warn('[camera-control] Sony SDK bridge unavailable:', message);
        return;
      }
    }

    this.registry?.update('camera-control', 'running');
  }

  async stop(): Promise<void> {
    this.sdkBridgeProcess?.kill();
    this.sdkBridgeProcess = null;
    this.registry?.update('camera-control', 'stopped');
  }

  async ensureSdkBridgeReady(configOverride?: Partial<CameraConfig>): Promise<void> {
    const config = resolveCameraConfig(configOverride);
    if (config.provider !== 'sony-sdk') return;

    if (await this.isSdkBridgeHealthy(config)) {
      this.registry?.update('camera-control', 'running');
      return;
    }

    if (!config.sdkBridge.autoStart) {
      throw new Error(
        `Sony SDK bridge is not reachable at ${config.sdkBridge.baseUrl}. Start the bridge manually or enable auto-start.`,
      );
    }

    const executable = config.sdkBridge.executablePath;
    if (!executable) {
      throw new Error('Sony SDK bridge executable is not configured.');
    }
    if (!fs.existsSync(executable)) {
      throw new Error(
        `Sony SDK bridge executable not found at ${executable}. Build or place the bridge there, or update camera.sdkBridge.executablePath.`,
      );
    }

    if (!this.sdkBridgeProcess || this.sdkBridgeProcess.killed) {
      this.spawnSdkBridge(config);
    }

    const deadline = Date.now() + config.sdkBridge.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isSdkBridgeHealthy(config)) {
        this.registry?.update('camera-control', 'running');
        return;
      }
      await delay(250);
    }

    throw new Error(
      `Sony SDK bridge did not become ready within ${config.sdkBridge.startupTimeoutMs}ms at ${config.sdkBridge.baseUrl}.`,
    );
  }

  async getConnectionSummary(configOverride?: Partial<CameraConfig>): Promise<CameraConnectResult> {
    const config = resolveCameraConfig(configOverride);
    const provider = this.getProvider(config);
    const capabilities = await provider.getAvailableApiList(config);
    const [status, whiteBalanceOptions, isoOptions] = await Promise.all([
      provider.getCameraEvent(config).catch(() => null),
      capabilities.includes('getAvailableWhiteBalance')
        ? provider.getAvailableWhiteBalance(config).catch(() => [])
        : [],
      capabilities.includes('getAvailableIsoSpeedRate')
        ? provider.getAvailableIsoSpeedRate(config).catch(() => [])
        : [],
    ]);

    return {
      provider: config.provider,
      model: config.model,
      capabilities,
      whiteBalanceOptions,
      isoOptions,
      status,
    };
  }

  async discoverCameras(configOverride?: Partial<CameraConfig>): Promise<DiscoveredCamera[]> {
    const config = resolveCameraConfig(configOverride);
    if (config.provider !== 'sony-sdk') {
      return [];
    }

    await this.ensureSdkBridgeReady(config);
    const url = new URL('camera/discover', config.sdkBridge.baseUrl.endsWith('/') ? config.sdkBridge.baseUrl : `${config.sdkBridge.baseUrl}/`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(await readJsonError(response));
    }

    const body = await response.json() as { cameras?: DiscoveredCamera[] };
    return body.cameras ?? [];
  }

  async getAvailableApiList(configOverride?: Partial<CameraConfig>): Promise<string[]> {
    const config = resolveCameraConfig(configOverride);
    return this.getProvider(config).getAvailableApiList(config);
  }

  async getCameraEvent(configOverride?: Partial<CameraConfig>): Promise<CameraStatus> {
    const config = resolveCameraConfig(configOverride);
    return this.getProvider(config).getCameraEvent(config);
  }

  async startMovieRec(configOverride?: Partial<CameraConfig>): Promise<void> {
    const config = resolveCameraConfig(configOverride);
    await this.getProvider(config).startMovieRec(config);
  }

  async stopMovieRec(configOverride?: Partial<CameraConfig>): Promise<void> {
    const config = resolveCameraConfig(configOverride);
    await this.getProvider(config).stopMovieRec(config);
  }

  // ── Multi-camera coordinated roll ─────────────────────────────────────────
  // These fan a record/stop command out to every *armed* camera independently.
  // They are best-effort by contract: the studio REC flow calls them AFTER the
  // ATEM+mixer core has committed, and a camera failing here never blocks the
  // shoot — the per-camera result just reports which bodies caught the take.

  /**
   * Per-camera connection settings for a roster entry. Credentials are per body
   * (Access Authentication is set on the camera), so a device that carries its own
   * falls back to the rig-wide values only where it leaves a field blank. Omitting
   * these entirely made every camera authenticate as the first one's password —
   * SDK::Connect then failed, while the TCP:80 reachability probe still reported
   * the camera "online", so the failure looked like a broken REC command.
   */
  private deviceOverride(device: SonyCameraDevice): Partial<CameraConfig> {
    const override: Partial<CameraConfig> = {
      host: device.host,
      ip: device.host,
      model: device.model,
    };
    if (device.username) override.username = device.username;
    if (device.password) override.password = device.password;
    if (device.fingerprint) override.fingerprint = device.fingerprint;
    // The SDK keys Ethernet cameras by MAC. Without a real one per body, every camera
    // collides as a single device inside the SDK. Captured during the network scan.
    if (device.mac) override.mac = device.mac;
    return override;
  }

  /** Poll a camera's status until `recording` matches `want`, or the timeout elapses. */
  private async confirmRecordingState(device: SonyCameraDevice, want: boolean): Promise<void> {
    const deadline = Date.now() + ROLL_CONFIRM_TIMEOUT_MS;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const status = await this.getCameraEvent(this.deviceOverride(device));
        if (status.recording === want) return;
      } catch (err) {
        lastErr = (err as Error).message;
      }
      await delay(ROLL_CONFIRM_POLL_MS);
    }
    throw new Error(lastErr || `Timed out waiting for camera to ${want ? 'start' : 'stop'} recording`);
  }

  /**
   * Serialize work for one camera host: each task runs only after the previous task
   * for the same host settles (success or failure), so a stop can never interleave
   * with an in-flight start mid-toggle. Failures don't poison the chain.
   */
  private serializeByHost<T>(host: string, task: () => Promise<T>): Promise<T> {
    const prev = this.rollChain.get(host) ?? Promise.resolve();
    const next = prev.then(task, task);
    // Keep the chain alive but swallow the result so a rejection can't break the
    // next link and the retained promise never keeps a value/error referenced.
    this.rollChain.set(host, next.then(() => undefined, () => undefined));
    return next;
  }

  private async rollOne(device: SonyCameraDevice, action: 'start' | 'stop'): Promise<CameraRollResult> {
    // Stamp intent synchronously, in press order, BEFORE queuing. Whichever command
    // for this host is stamped last wins; earlier queued rolls will see they are no
    // longer the latest intent and drop out without touching the camera.
    const seq = ++this.rollSeq;
    this.latestRollSeq.set(device.host, seq);
    return this.serializeByHost(device.host, () => this.rollOneCommit(device, action, seq));
  }

  private async rollOneCommit(
    device: SonyCameraDevice,
    action: 'start' | 'stop',
    seq: number,
  ): Promise<CameraRollResult> {
    const base: Omit<CameraRollResult, 'ok' | 'error' | 'recording'> = {
      id: device.id, label: device.label, host: device.host, model: device.model,
    };

    // Superseded by a newer command for this host while we waited our turn — the
    // newer command owns the final state. Drop out silently rather than send a stale
    // toggle that would flip the camera the wrong way.
    if (this.latestRollSeq.get(device.host) !== seq) {
      console.log(`[camera-control] ${action} on ${device.label} (${device.host}) superseded before dispatch; skipping`);
      return { ...base, ok: true, recording: null };
    }

    // Reachability gate. A REC command to a body that isn't on the network blocks
    // ~45s inside the SDK bridge; if the body returns during that window the toggle
    // fires late — after any newer stop — and leaves it rolling. Never dispatch to a
    // dark camera: probe first (cheap TCP, no SDK session) and skip if it's offline.
    if (!(await probeReachable(device.host))) {
      if (action === 'start') {
        console.warn(`[camera-control] start SKIPPED on ${device.label} (${device.host}): camera offline`);
        return { ...base, ok: false, error: 'camera offline', recording: false };
      }
      // A powered-off camera cannot be recording; report the stop as a clean no-op.
      console.log(`[camera-control] stop no-op on ${device.label} (${device.host}): camera offline`);
      return { ...base, ok: true, recording: false };
    }

    // A newer command may have landed while we probed. Send the toggle only if we're
    // still the latest word for this host.
    if (this.latestRollSeq.get(device.host) !== seq) {
      console.log(`[camera-control] ${action} on ${device.label} (${device.host}) superseded during probe; skipping`);
      return { ...base, ok: true, recording: null };
    }

    try {
      const override = this.deviceOverride(device);
      if (action === 'start') await this.startMovieRec(override);
      else await this.stopMovieRec(override);
      await this.confirmRecordingState(device, action === 'start');
      console.log(`[camera-control] ${action} OK on ${device.label} (${device.host})`);
      return { ...base, ok: true, recording: action === 'start' };
    } catch (err) {
      const error = (err as Error).message;
      const recording = await this.readRecordingState(device);

      // A stop that "failed" on a camera we can see is not recording never had
      // anything to stop — typically its start was refused (no media) so it never
      // rolled. Reporting that as a stop failure told the operator the camera might
      // still be recording, which is the opposite of the truth.
      if (action === 'stop' && recording === false) {
        console.log(`[camera-control] stop no-op on ${device.label} (${device.host}): was not recording`);
        return { ...base, ok: true, recording: false };
      }

      // The roll is best-effort and never throws, so without this the only trace of
      // a camera refusing to record was a transient toast.
      console.warn(`[camera-control] ${action} FAILED on ${device.label} (${device.host}): ${error}`);
      return { ...base, ok: false, error, recording };
    }
  }

  /** The camera's own recording state, or null when it can't be read. Never throws. */
  private async readRecordingState(device: SonyCameraDevice): Promise<boolean | null> {
    try {
      const status = await this.getCameraEvent(this.deviceOverride(device));
      return status.recording;
    } catch {
      return null;
    }
  }

  /** Start recording on every armed camera in parallel. Never throws. */
  async recordAllArmed(): Promise<CameraRollResult[]> {
    const armed = getArmedCameras();
    return Promise.all(armed.map((d) => this.rollOne(d, 'start')));
  }

  /** Stop recording on every armed camera in parallel. Never throws. */
  async stopAllArmed(): Promise<CameraRollResult[]> {
    const armed = getArmedCameras();
    return Promise.all(armed.map((d) => this.rollOne(d, 'stop')));
  }

  /**
   * Software timecode "soft jam" of every armed camera to `timecode` (Free-Run +
   * Preset). Best-effort and parallel; never throws. Not frame-accurate — the value
   * lands after each camera's network delivery delay, so cameras end up within that
   * skew of each other, not phase-locked. Off the REC hot path entirely.
   */
  async jamAllArmed(timecode: string, dropFrame: boolean): Promise<TimecodeJamResult[]> {
    const armed = getArmedCameras();
    return Promise.all(armed.map(async (device): Promise<TimecodeJamResult> => {
      const base = { id: device.id, label: device.label, host: device.host };
      if (!(await probeReachable(device.host))) {
        return { ...base, ok: false, error: 'camera offline' };
      }
      try {
        const config = resolveCameraConfig(this.deviceOverride(device));
        const readBack = await this.sdkProvider.jamTimecode(config, timecode, dropFrame);
        console.log(`[camera-control] jammed ${device.label} (${device.host}) → ${readBack}`);
        return { ...base, ok: true, timecode: readBack };
      } catch (err) {
        const error = (err as Error).message;
        console.warn(`[camera-control] timecode jam FAILED on ${device.label} (${device.host}): ${error}`);
        return { ...base, ok: false, error };
      }
    }));
  }

  /**
   * Warm up sessions to all armed cameras (best-effort, parallel, swallows errors)
   * so the first REC press doesn't pay cold-connect latency. Safe to call repeatedly.
   */
  async preconnectArmed(): Promise<void> {
    const armed = getArmedCameras();
    await Promise.all(
      armed.map((d) => this.getCameraEvent(this.deviceOverride(d)).catch(() => null)),
    );
  }

  /**
   * Liveness + state for every rostered camera. Reachability is a cheap TCP probe
   * (no SDK session); armed cameras additionally get a real status read, which
   * doubles as a keepalive so their session stays connected between takes.
   * Purely informational — never throws, never blocks recording.
   *
   * With `sdkReads: false` (idle mode) it does TCP probes only — no SDK calls, so
   * the bridge is never spawned. Used while the tier is idled to detect a camera
   * returning to the network without paying connect cost every cycle.
   */
  async pollCameraHealth(opts: { sdkReads?: boolean } = {}): Promise<CameraHealth[]> {
    const sdkReads = opts.sdkReads !== false;
    const roster = readStudioConfig().camera.cameras.filter((c) => c.host.length > 0);
    return Promise.all(roster.map(async (device): Promise<CameraHealth> => {
      const base = {
        id: device.id, label: device.label, host: device.host,
        model: device.model, armed: device.armed, checkedAt: new Date().toISOString(),
      };
      const offline: CameraHealth = {
        ...base, online: false, recording: false, batteryPercent: null, remainingSeconds: null,
      };

      if (!(await probeReachable(device.host))) return offline;
      if (!device.armed || !sdkReads) {
        return { ...base, online: true, recording: false, batteryPercent: null, remainingSeconds: null };
      }

      try {
        const status = await this.getCameraEvent(this.deviceOverride(device));
        return {
          ...base,
          online: true,
          recording: status.recording,
          batteryPercent: status.batteryPercent ?? null,
          remainingSeconds: status.remainingSeconds ?? null,
        };
      } catch (err) {
        // Reachable on the network but the SDK couldn't talk to it (asleep, busy,
        // held by another controller). Report it rather than calling it offline.
        return { ...base, online: true, recording: false, batteryPercent: null, remainingSeconds: null, error: (err as Error).message };
      }
    }));
  }

  /**
   * A camera is addressed by IP, so a new DHCP lease silently breaks its roster
   * entry. If we recorded its MAC during a scan, re-discover it and repoint the
   * roster at the new address. Returns the new host when one was recovered.
   */
  async recoverHostByMac(device: SonyCameraDevice): Promise<string | null> {
    if (!device.mac) return null;
    let found: DiscoveredCamera[];
    try {
      found = await this.discoverCameras();
    } catch {
      return null;
    }
    const wanted = device.mac.toUpperCase();
    const match = found.find((c) => (c.macAddress ?? '').toUpperCase() === wanted);
    if (!match?.host || match.host === device.host) return null;

    const cameras = readStudioConfig().camera.cameras.map((c) =>
      c.id === device.id ? { ...c, host: match.host } : c,
    );
    patchStudioConfig({ camera: { cameras } });
    return match.host;
  }

  async getAvailableWhiteBalance(configOverride?: Partial<CameraConfig>): Promise<string[]> {
    const config = resolveCameraConfig(configOverride);
    return this.getProvider(config).getAvailableWhiteBalance(config);
  }

  async setWhiteBalance(mode: string, configOverride?: Partial<CameraConfig>): Promise<void> {
    const config = resolveCameraConfig(configOverride);
    await this.getProvider(config).setWhiteBalance(config, mode);
  }

  async getAvailableIsoSpeedRate(configOverride?: Partial<CameraConfig>): Promise<string[]> {
    const config = resolveCameraConfig(configOverride);
    return this.getProvider(config).getAvailableIsoSpeedRate(config);
  }

  async setIsoSpeedRate(iso: string, configOverride?: Partial<CameraConfig>): Promise<void> {
    const config = resolveCameraConfig(configOverride);
    await this.getProvider(config).setIsoSpeedRate(config, iso);
  }

  async openLiveview(configOverride?: Partial<CameraConfig>): Promise<CameraStreamResponse> {
    const config = resolveCameraConfig(configOverride);
    return this.getProvider(config).openLiveview(config);
  }

  async callMethod(method: string, params: unknown[] = [], configOverride?: Partial<CameraConfig>): Promise<unknown> {
    const config = resolveCameraConfig(configOverride);
    return this.getProvider(config).callMethod(config, method, params);
  }

  private getProvider(config: CameraConfig): CameraProvider {
    return config.provider === 'sony-sdk' ? this.sdkProvider : this.legacyProvider;
  }

  private spawnSdkBridge(config: CameraConfig): void {
    const args = [...config.sdkBridge.args];
    const process = spawn(config.sdkBridge.executablePath, args, {
      cwd: path.dirname(config.sdkBridge.executablePath),
      stdio: 'pipe',
    });

    // Emit one console line per bridge line. The pipe delivers arbitrary chunks — a
    // chunk can hold several lines or split one mid-way — so buffer and split on '\n',
    // else the prefix lands in the middle of a line and lines interleave/garble.
    const lineEmitter = (emit: (line: string) => void) => {
      let buffer = '';
      return (chunk: Buffer) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trimEnd();
          buffer = buffer.slice(nl + 1);
          if (line) emit(line);
        }
      };
    };
    process.stdout.on('data', lineEmitter((line) => console.log(`[camera-control] bridge: ${line}`)));
    process.stderr.on('data', lineEmitter((line) => console.warn(`[camera-control] bridge: ${line}`)));
    process.on('exit', (code, signal) => {
      console.warn(`[camera-control] Sony SDK bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      if (this.sdkBridgeProcess === process) {
        this.sdkBridgeProcess = null;
      }
    });

    this.sdkBridgeProcess = process;
  }

  private async isSdkBridgeHealthy(config: CameraConfig): Promise<boolean> {
    try {
      const url = new URL('health', config.sdkBridge.baseUrl.endsWith('/') ? config.sdkBridge.baseUrl : `${config.sdkBridge.baseUrl}/`);
      const response = await fetch(url);
      if (!response.ok) return false;
      const body = await response.json() as CameraBridgeHealth;
      return body.ok !== false;
    } catch {
      return false;
    }
  }
}

export type { CameraStatus };
