/**
 * In-memory registry of connected EditPanel instances.
 *
 * Populated by POST /api/ep/status heartbeats (every ~10s per instance).
 * An instance is considered offline if its last heartbeat was >30s ago.
 *
 * No persistence — instances re-register within one heartbeat interval after
 * a server restart.
 */

export interface EpInstance {
  instanceId: string;
  displayName: string;
  lastSeen: number;          // Date.now()
  resolveConnected: boolean;
  resolveProject: string | null;
  resolveTimeline: string | null;
  jobsQueued: number;
  jobsRunning: number;
}

export interface EpInstanceWithStatus extends EpInstance {
  online: boolean;
}

const OFFLINE_THRESHOLD_MS = 30_000;

const instances = new Map<string, EpInstance>();

export function upsertInstance(
  data: Omit<EpInstance, 'lastSeen'>,
): EpInstanceWithStatus {
  const instance: EpInstance = { ...data, lastSeen: Date.now() };
  instances.set(data.instanceId, instance);
  return { ...instance, online: true };
}

export function getAllInstances(): EpInstanceWithStatus[] {
  const now = Date.now();
  return Array.from(instances.values()).map((inst) => ({
    ...inst,
    online: now - inst.lastSeen < OFFLINE_THRESHOLD_MS,
  }));
}

export function getInstanceById(id: string): EpInstanceWithStatus | null {
  const inst = instances.get(id);
  if (!inst) return null;
  return { ...inst, online: Date.now() - inst.lastSeen < OFFLINE_THRESHOLD_MS };
}
