/**
 * Persists studio hardware configuration (camera control, NAS FTP, etc.)
 * Stored at data/studio-config.json
 */

import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'studio-config.json');

function defaultSdkBridgeExecutable(): string {
  if (process.platform === 'darwin') {
    return path.join(process.cwd(), 'vendor', 'sony-camera-bridge', 'mac-arm64', 'sony-camera-bridge');
  }
  return path.join(process.cwd(), 'vendor', 'sony-camera-bridge', 'win-x64', 'sony-camera-bridge.exe');
}

const DEFAULT_SDK_BRIDGE_EXECUTABLE = defaultSdkBridgeExecutable();

export type CameraProviderKind = 'sony-sdk' | 'sony-camera-api';
export type SonyCameraModel = 'fx6' | 'fx3';

export interface SonySdkBridgeConfig {
  baseUrl: string;
  executablePath: string;
  autoStart: boolean;
  startupTimeoutMs: number;
  args: string[];
}

export type { AmaranFixtureGroup } from '@/lib/lighting-constants';
export { AMARAN_GROUPS } from '@/lib/lighting-constants';
import type { AmaranFixtureGroup } from '@/lib/lighting-constants';

export interface AmaranConfig {
  port: number;        // Amaran Desktop WebSocket port (default 33782)
  autoConnect: boolean;
  fixtureLabels: Record<string, string>;                  // nodeId → display name override
  fixtureGroups: Record<string, AmaranFixtureGroup>;      // nodeId → section assignment
  fixtureOrder:  Record<AmaranFixtureGroup, string[]>;    // group → ordered nodeIds
}

export interface WledConfig {
  ip: string;          // IP address of the WLED device (e.g. "192.168.1.50")
}

export interface CameraConfig {
  provider: CameraProviderKind;
  model: SonyCameraModel;
  host: string;
  username: string;
  password: string;
  fingerprint: string;
  // `ip` remains for backward compatibility with older stored configs and UI callers.
  ip: string;
  port: number;
  sdkBridge: SonySdkBridgeConfig;
}

export interface StudioConfig {
  camera: CameraConfig;
  amaran: AmaranConfig;
  wled:   WledConfig;
}

export interface StudioConfigPatch {
  camera?: Partial<CameraConfig>;
  amaran?: Partial<AmaranConfig>;
  wled?:  Partial<WledConfig>;
}

const WLED_DEFAULTS: WledConfig = {
  ip: '',
};

const DEFAULTS: StudioConfig = {
  camera: {
    provider: 'sony-sdk',
    model: 'fx6',
    host: '',
    username: '',
    password: '',
    fingerprint: '',
    ip: '',
    port: 10000,
    sdkBridge: {
      baseUrl: 'http://127.0.0.1:6107',
      executablePath: DEFAULT_SDK_BRIDGE_EXECUTABLE,
      autoStart: true,
      startupTimeoutMs: 60_000,
      args: [],
    },
  },
  amaran: {
    port: 33782,
    autoConnect: true,
    fixtureLabels: {},
    fixtureGroups: {},
    fixtureOrder:  { bookshelves: [], void: [], mobile: [] },
  },
  wled: { ...WLED_DEFAULTS },
};

function normalizeCameraConfig(camera?: Partial<CameraConfig>): CameraConfig {
  const mergedBridge = {
    ...DEFAULTS.camera.sdkBridge,
    ...(camera?.sdkBridge ?? {}),
  };

  const host = (camera?.host ?? camera?.ip ?? '').trim();
  const username = (camera?.username ?? '').trim();
  const password = camera?.password ?? '';
  const fingerprint = (camera?.fingerprint ?? '').replace(/\s+/g, '');
  const port = Number.isFinite(camera?.port) ? Number(camera?.port) : DEFAULTS.camera.port;

  // If the stored executable path is for the wrong platform (e.g. a Windows .exe
  // path loaded on macOS after a machine migration), fall back to the platform default.
  const storedExe = (mergedBridge.executablePath ?? '').trim();
  const wrongPlatformExe =
    (process.platform === 'darwin' && storedExe.endsWith('.exe')) ||
    (process.platform === 'win32' && !storedExe.endsWith('.exe') && storedExe !== '');
  const executablePath = wrongPlatformExe || !storedExe
    ? DEFAULTS.camera.sdkBridge.executablePath
    : storedExe;

  return {
    ...DEFAULTS.camera,
    ...camera,
    host,
    username,
    password,
    fingerprint,
    ip: host,
    port,
    sdkBridge: {
      ...mergedBridge,
      baseUrl: (mergedBridge.baseUrl ?? DEFAULTS.camera.sdkBridge.baseUrl).trim(),
      executablePath,
      args: Array.isArray(mergedBridge.args) ? mergedBridge.args : [],
    },
  };
}

function normalizeStudioConfig(raw?: Partial<StudioConfig>): StudioConfig {
  return {
    camera: normalizeCameraConfig(raw?.camera),
    amaran: {
      port: typeof raw?.amaran?.port === 'number' && raw.amaran.port > 0 ? raw.amaran.port : DEFAULTS.amaran.port,
      autoConnect: raw?.amaran?.autoConnect ?? DEFAULTS.amaran.autoConnect,
      fixtureLabels: (typeof raw?.amaran?.fixtureLabels === 'object' && raw.amaran.fixtureLabels !== null)
        ? raw.amaran.fixtureLabels as Record<string, string>
        : {},
      fixtureGroups: (typeof raw?.amaran?.fixtureGroups === 'object' && raw.amaran.fixtureGroups !== null)
        ? raw.amaran.fixtureGroups as Record<string, AmaranFixtureGroup>
        : {},
      fixtureOrder: {
        bookshelves: Array.isArray(raw?.amaran?.fixtureOrder?.bookshelves) ? raw.amaran.fixtureOrder.bookshelves : [],
        void:        Array.isArray(raw?.amaran?.fixtureOrder?.void)        ? raw.amaran.fixtureOrder.void        : [],
        mobile:      Array.isArray(raw?.amaran?.fixtureOrder?.mobile)      ? raw.amaran.fixtureOrder.mobile      : [],
      },
    },
    wled: {
      ip: typeof raw?.wled?.ip === 'string' ? raw.wled.ip.trim() : WLED_DEFAULTS.ip,
    },
  };
}

export function readStudioConfig(): StudioConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Partial<StudioConfig>;
    return normalizeStudioConfig(parsed);
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function writeStudioConfig(config: StudioConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalizeStudioConfig(config), null, 2), 'utf-8');
}

export function patchStudioConfig(patch: StudioConfigPatch): StudioConfig {
  const current = readStudioConfig();
  const next = normalizeStudioConfig({
    ...current,
    ...patch,
    camera: {
      ...current.camera,
      ...(patch.camera ?? {}),
      sdkBridge: {
        ...current.camera.sdkBridge,
        ...(patch.camera?.sdkBridge ?? {}),
      },
    },
    amaran: {
      ...current.amaran,
      ...(patch.amaran ?? {}),
    },
    wled: {
      ...current.wled,
      ...(patch.wled ?? {}),
    },
  });
  writeStudioConfig(next);
  return next;
}
