import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'storage-config.json');
const DEFAULT_THRESHOLD_PERCENT = 90;
const DEFAULT_RESERVE_BYTES = 25 * 1024 * 1024 * 1024;
const DEFAULT_MANAGED_ROOT = 'LPOS';

export interface StorageVolumePreference {
  rootPath: string;
  enabled: boolean;
  priority: number;
}

export interface StorageConfig {
  adminPinHash: string | null;
  thresholdPercent: number;
  reserveBytes: number;
  managedRootName: string;
  volumes: StorageVolumePreference[];
  updatedAt: string | null;
}

export interface StorageConfigPatch {
  adminPinHash?: string | null;
  thresholdPercent?: number;
  reserveBytes?: number;
  managedRootName?: string;
  volumes?: StorageVolumePreference[];
}

const DEFAULTS: StorageConfig = {
  adminPinHash: null,
  thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
  reserveBytes: DEFAULT_RESERVE_BYTES,
  managedRootName: DEFAULT_MANAGED_ROOT,
  volumes: [],
  updatedAt: null,
};

function normalizeRootPath(rootPath: string): string {
  let normalized = rootPath.trim();
  if (/^[a-zA-Z]:$/.test(normalized)) normalized = `${normalized}\\`;
  if (/^[a-zA-Z]:\\?$/.test(normalized)) {
    const drive = normalized.slice(0, 1).toUpperCase();
    return `${drive}:\\`;
  }

  normalized = normalized.replace(/[\\/]+$/, '');
  return path.normalize(normalized);
}

function normalizeVolumes(volumes?: StorageVolumePreference[]): StorageVolumePreference[] {
  if (!Array.isArray(volumes)) return [];

  const seen = new Set<string>();
  return volumes
    .map((volume, index) => {
      const rootPath = normalizeRootPath(volume.rootPath);
      return {
        rootPath,
        enabled: Boolean(volume.enabled),
        priority: Number.isFinite(volume.priority) ? Number(volume.priority) : index,
      };
    })
    .filter((volume) => {
      if (!volume.rootPath || seen.has(volume.rootPath)) return false;
      seen.add(volume.rootPath);
      return true;
    })
    .sort((a, b) => a.priority - b.priority)
    .map((volume, index) => ({ ...volume, priority: index }));
}

function normalizeStorageConfig(raw?: Partial<StorageConfig>): StorageConfig {
  const thresholdPercent = Number.isFinite(raw?.thresholdPercent)
    ? Math.min(98, Math.max(50, Number(raw?.thresholdPercent)))
    : DEFAULT_THRESHOLD_PERCENT;
  const reserveBytes = Number.isFinite(raw?.reserveBytes)
    ? Math.max(0, Number(raw?.reserveBytes))
    : DEFAULT_RESERVE_BYTES;
  const managedRootName = (raw?.managedRootName ?? DEFAULT_MANAGED_ROOT).trim() || DEFAULT_MANAGED_ROOT;

  return {
    adminPinHash: raw?.adminPinHash ?? null,
    thresholdPercent,
    reserveBytes,
    managedRootName,
    volumes: normalizeVolumes(raw?.volumes),
    updatedAt: raw?.updatedAt ?? null,
  };
}

export function readStorageConfig(): StorageConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Partial<StorageConfig>;
    return normalizeStorageConfig(parsed);
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function writeStorageConfig(config: StorageConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      ...normalizeStorageConfig(config),
      updatedAt: new Date().toISOString(),
    }, null, 2),
    'utf-8',
  );
}

export function patchStorageConfig(patch: StorageConfigPatch): StorageConfig {
  const current = readStorageConfig();
  const next = normalizeStorageConfig({
    ...current,
    ...patch,
    volumes: patch.volumes ?? current.volumes,
  });
  const withTimestamp = {
    ...next,
    updatedAt: new Date().toISOString(),
  };
  writeStorageConfig(withTimestamp);
  return withTimestamp;
}

export function sanitizeStorageConfig(config: StorageConfig): Omit<StorageConfig, 'adminPinHash'> {
  return {
    thresholdPercent: config.thresholdPercent,
    reserveBytes: config.reserveBytes,
    managedRootName: config.managedRootName,
    volumes: config.volumes,
    updatedAt: config.updatedAt,
  };
}
