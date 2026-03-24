import fs from 'node:fs';
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
  type CameraConfig,
  type CameraProviderKind,
  type SonyCameraModel,
} from '@/lib/store/studio-config-store';

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
      `camera/status?host=${encodeURIComponent(config.host)}&model=${encodeURIComponent(config.model)}&username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}&fingerprint=${encodeURIComponent(config.fingerprint)}`,
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
      `camera/settings/white-balance/options?host=${encodeURIComponent(config.host)}&model=${encodeURIComponent(config.model)}&username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}&fingerprint=${encodeURIComponent(config.fingerprint)}`,
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
      `camera/settings/iso/options?host=${encodeURIComponent(config.host)}&model=${encodeURIComponent(config.model)}&username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}&fingerprint=${encodeURIComponent(config.fingerprint)}`,
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

    process.stdout.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[camera-control] bridge: ${text}`);
    });
    process.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[camera-control] bridge error: ${text}`);
    });
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
