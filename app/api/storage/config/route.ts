import { NextRequest, NextResponse } from 'next/server';
import { getStorageAllocationDecision, invalidateStorageCache } from '@/lib/services/storage-volume-service';
import { storageAuthSummary } from '@/lib/services/storage-auth';
import { patchStorageConfig, readStorageConfig, sanitizeStorageConfig } from '@/lib/store/storage-config-store';

export async function GET(req: NextRequest) {
  const auth = storageAuthSummary(req);
  const config = readStorageConfig();
  const decision = getStorageAllocationDecision();

  if (!auth.bootstrapped || auth.unlocked) {
    return NextResponse.json({
      ...auth,
      config: sanitizeStorageConfig(config),
      allocation: decision,
    });
  }

  return NextResponse.json({
    ...auth,
    allocation: {
      active: decision.active ? {
        rootPath: decision.active.rootPath,
        label: decision.active.label,
        managedRoot: decision.active.managedRoot,
      } : null,
      volumes: decision.volumes.map((volume) => ({
        rootPath: volume.rootPath,
        label: volume.label,
        available: volume.available,
        usedPercent: volume.usedPercent,
      })),
    },
  });
}

export async function PUT(req: NextRequest) {
  void readStorageConfig();

  const body = await req.json().catch(() => ({})) as {
    thresholdPercent?: number;
    reserveBytes?: number;
    managedRootName?: string;
    volumes?: Array<{ rootPath?: string; enabled?: boolean; priority?: number }>;
  };

  const nextVolumes = Array.isArray(body.volumes) ? body.volumes : [];
  const enabledCount = nextVolumes.filter((volume) => volume.enabled).length;
  if (enabledCount === 0) {
    return NextResponse.json({ error: 'Enable at least one storage drive.' }, { status: 400 });
  }

  const next = patchStorageConfig({
    thresholdPercent: body.thresholdPercent,
    reserveBytes: body.reserveBytes,
    managedRootName: body.managedRootName,
    volumes: nextVolumes.map((volume, index) => ({
      rootPath: volume.rootPath ?? '',
      enabled: Boolean(volume.enabled),
      priority: Number.isFinite(volume.priority) ? Number(volume.priority) : index,
    })),
  });

  // Config changed — drop the cached drive scan so the new preference is reflected
  invalidateStorageCache();

  return NextResponse.json({
    ok: true,
    config: sanitizeStorageConfig(next),
    allocation: getStorageAllocationDecision(),
  });
}
