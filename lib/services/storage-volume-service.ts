import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

function detectWindowsVolumes(): DetectedVolume[] {
  const script = [
    '$drives = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3 } | ForEach-Object {',
    '  [PSCustomObject]@{',
    '    rootPath = if ($_.DeviceID.EndsWith(\"\\\\\")) { $_.DeviceID } else { \"$($_.DeviceID)\\\\\" }',
    '    label = if ($_.VolumeName) { $_.VolumeName } else { $_.DeviceID }',
    '    totalBytes = if ($_.Size) { [int64]$_.Size } else { $null }',
    '    freeBytes = if ($_.FreeSpace) { [int64]$_.FreeSpace } else { $null }',
    '  }',
    '}',
    '$drives | ConvertTo-Json -Compress',
  ].join(' ');

  const result = spawnSync(
    'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-Command', script],
    { encoding: 'utf8', timeout: 5000 },
  );

  if (result.status !== 0 || !result.stdout.trim()) return [];

  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      rootPath: string;
      label: string;
      totalBytes: number | null;
      freeBytes: number | null;
    }> | {
      rootPath: string;
      label: string;
      totalBytes: number | null;
      freeBytes: number | null;
    };
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => {
      const rootPath = normalizeRootPath(row.rootPath);
      let writable = false;
      let available = false;
      try {
        available = fs.existsSync(rootPath);
        if (available) fs.accessSync(rootPath, fs.constants.W_OK);
        writable = available;
      } catch {
        writable = false;
      }

      return {
        rootPath,
        label: row.label || rootPath,
        totalBytes: typeof row.totalBytes === 'number' ? row.totalBytes : null,
        freeBytes: typeof row.freeBytes === 'number' ? row.freeBytes : null,
        available,
        writable,
      };
    });
  } catch {
    return [];
  }
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

export function getStorageAllocationDecision(): StorageAllocationDecision {
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
  return {
    active: eligible[0] ?? null,
    next: eligible[1] ?? null,
    volumes: states,
  };
}

export function resolveProjectMediaStorageDir(projectId: string): string {
  const decision = getStorageAllocationDecision();
  if (!decision.active) {
    throw new Error('No eligible LPOS storage drive is available. Add or enable a writable volume in Storage Settings.');
  }

  const base = path.join(decision.active.managedRoot, 'projects', projectId);
  for (const sub of ['media', 'transcripts', 'subtitles']) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
  return path.join(base, 'media');
}
