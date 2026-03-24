/**
 * Persists studio hardware configuration (camera control, NAS FTP, etc.)
 * Stored at data/studio-config.json
 */

import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'studio-config.json');
const DEFAULT_SDK_BRIDGE_EXECUTABLE = path.join(
  process.cwd(),
  'vendor',
  'sony-camera-bridge',
  'win-x64',
  'sony-camera-bridge.exe',
);

export type CameraProviderKind = 'sony-sdk' | 'sony-camera-api';
export type SonyCameraModel = 'fx6' | 'fx3';

export interface SonySdkBridgeConfig {
  baseUrl: string;
  executablePath: string;
  autoStart: boolean;
  startupTimeoutMs: number;
  args: string[];
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
}

export interface StudioConfigPatch {
  camera?: Partial<CameraConfig>;
}

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
      executablePath: (mergedBridge.executablePath ?? DEFAULTS.camera.sdkBridge.executablePath).trim(),
      args: Array.isArray(mergedBridge.args) ? mergedBridge.args : [],
    },
  };
}

function normalizeStudioConfig(raw?: Partial<StudioConfig>): StudioConfig {
  return {
    camera: normalizeCameraConfig(raw?.camera),
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
  });
  writeStudioConfig(next);
  return next;
}
