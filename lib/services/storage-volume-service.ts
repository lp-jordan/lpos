import fs from 'node:fs';
import path from 'node:path';
import { readStorageConfig } from '@/lib/store/storage-config-store';

export interface DetectedVolume {
  rootPath: string;
  label: string;
  totalBytes: number | null;
  freeBytes: number | null;
  available: boolean;
  writable: boolean;
}

export interface StorageVolumeState extends DetectedVolume {
  enabled: boolean;
  priority: number | null;
  managedRoot: string;
  usedPercent: number | null;
  eligible: boolean;
  reason: string | null;
}

export interface StorageAllocationDecision {
  active: StorageVolumeState | null;
  next: StorageVolumeState | null;
  volumes: StorageVolumeState[];
}

function normalizeRootPath(rootPath: string): string {
  if (/^[a-zA-Z]:\\?$/.test(rootPath.trim())) {
    const drive = rootPath.trim().slice(0, 1).toUpperCase();
    return `${drive}:\\`;
  }
  return path.normalize(rootPath);
}

function getPathCapacity(rootPath: string): { totalBytes: number | null; freeBytes: number | null } {
  try {
    if (typeof fs.statfsSync !== 'function') return { totalBytes: null, freeBytes: null };
    const stat = fs.statfsSync(rootPath);
    const blockSize = typeof stat.bsize === 'number' ? stat.bsize : 0;
    const totalBlocks = typeof stat.blocks === 'number' ? stat.blocks : 0;
    const freeBlocks = typeof stat.bavail === 'number'
      ? stat.bavail
      : (typeof stat.bfree === 'number' ? stat.bfree : 0);
    if (blockSize <= 0 || totalBlocks <= 0) return { totalBytes: null, freeBytes: null };
    return {
      totalBytes: blockSize * totalBlocks,
      freeBytes: blockSize * freeBlocks,
    };
  } catch {
    return { totalBytes: null, freeBytes: null };
  }
}

function detectWindowsVolumes(): DetectedVolume[] {
  const volumes: DetectedVolume[] = [];
  for (let code = 67; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const rootPath = `${letter}:\\`;

    let available = false;
    let writable = false;
    try {
      available = fs.existsSync(rootPath);
      if (!available) continue;
      try {
        fs.accessSync(rootPath, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
    } catch {
      continue;
    }

    const capacity = getPathCapacity(rootPath);
    volumes.push({
      rootPath,
      label: `${letter}:`,
      totalBytes: capacity.totalBytes,
      freeBytes: capacity.freeBytes,
      available,
      writable,
    });
  }
  return volumes;
}

function detectFallbackVolumes(): DetectedVolume[] {
  const rootPath = path.parse(process.cwd()).root;
  let writable = false;
  let available = false;
  try {
    available = fs.existsSync(rootPath);
    if (available) fs.accessSync(rootPath, fs.constants.W_OK);
    writable = available;
  } catch {
    writable = false;
  }

  return [{
    rootPath,
    label: rootPath,
    totalBytes: null,
    freeBytes: null,
    available,
    writable,
  }];
}

export function detectHostVolumes(): DetectedVolume[] {
  const volumes = process.platform === 'win32' ? detectWindowsVolumes() : detectFallbackVolumes();
  return volumes.sort((a, b) => a.rootPath.localeCompare(b.rootPath));
}

function buildReason(
  volume: DetectedVolume,
  enabled: boolean,
  thresholdPercent: number,
  reserveBytes: number,
): string | null {
  if (!enabled) return 'Disabled';
  if (!volume.available) return 'Drive not mounted';
  if (!volume.writable) return 'Drive is not writable';
  if (typeof volume.freeBytes === 'number' && volume.freeBytes <= reserveBytes) return 'Below reserve free space';
  if (
    typeof volume.totalBytes === 'number'
    && typeof volume.freeBytes === 'number'
    && volume.totalBytes > 0
    && ((volume.totalBytes - volume.freeBytes) / volume.totalBytes) * 100 >= thresholdPercent
  ) {
    return `At or above ${thresholdPercent}% used`;
  }
  return null;
}

// ── Decision cache ───────────────────────────────────────────────────────────
// detectHostVolumes() probes all 24 Windows drive letters synchronously on
// every call. Drive letters don't change mid-session on their own — a user
// adding a new volume still has to enable it in Storage Settings, which goes
// through the PUT /api/storage/config route and calls invalidateStorageCache().
// So we cache for the lifetime of the process and only invalidate explicitly.

let _cachedDecision: StorageAllocationDecision | null = null;

/** Invalidate the cached storage decision — call after config changes or on error. */
export function invalidateStorageCache(): void {
  _cachedDecision = null;
}

export function getStorageAllocationDecision(): StorageAllocationDecision {
  if (_cachedDecision) return _cachedDecision;

  const config = readStorageConfig();
  const detected = detectHostVolumes();
  const preferenceMap = new Map(config.volumes.map((volume) => [normalizeRootPath(volume.rootPath), volume]));

  const states = detected.map((volume) => {
    const preference = preferenceMap.get(volume.rootPath);
    const usedPercent = (
      typeof volume.totalBytes === 'number'
      && typeof volume.freeBytes === 'number'
      && volume.totalBytes > 0
    )
      ? ((volume.totalBytes - volume.freeBytes) / volume.totalBytes) * 100
      : null;
    const enabled = Boolean(preference?.enabled);
    const reason = buildReason(volume, enabled, config.thresholdPercent, config.reserveBytes);

    return {
      ...volume,
      enabled,
      priority: typeof preference?.priority === 'number' ? preference.priority : null,
      managedRoot: path.join(volume.rootPath, config.managedRootName),
      usedPercent,
      eligible: reason === null,
      reason,
    } satisfies StorageVolumeState;
  }).sort((a, b) => {
    const left = a.priority ?? Number.MAX_SAFE_INTEGER;
    const right = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return a.rootPath.localeCompare(b.rootPath);
  });

  const eligible = states.filter((volume) => volume.eligible);
  const decision: StorageAllocationDecision = {
    active: eligible[0] ?? null,
    next: eligible[1] ?? null,
    volumes: states,
  };

  // Only cache when an active volume exists — if nothing is eligible we want
  // to re-probe on the next request so the user's fix is picked up immediately.
  if (decision.active) _cachedDecision = decision;

  return decision;
}

export function resolveProjectMediaStorageDir(projectId: string): string {
  const decision = getStorageAllocationDecision();
  if (!decision.active) {
    invalidateStorageCache();
    throw new Error('No eligible LPOS storage drive is available. Add or enable a writable volume in Storage Settings.');
  }

  const base = path.join(decision.active.managedRoot, 'projects', projectId);
  for (const sub of ['media', 'transcripts', 'subtitles']) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
  return path.join(base, 'media');
}
