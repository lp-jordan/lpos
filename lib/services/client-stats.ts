import { getProjectStore } from '@/lib/services/container';
import { readRegistry } from '@/lib/store/media-registry';
import { readScriptsRegistry } from '@/lib/store/scripts-registry';

export interface ClientStats {
  mediaCount: number;
  scriptCount: number;
}

const TTL_MS = 30_000;
let cache: { stats: Record<string, ClientStats>; at: number } | null = null;

export function getClientStats(): Record<string, ClientStats> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.stats;

  const projects = getProjectStore().getAll().filter((p) => !p.archived);
  const stats: Record<string, ClientStats> = {};

  for (const project of projects) {
    const client = project.clientName;
    if (!stats[client]) stats[client] = { mediaCount: 0, scriptCount: 0 };
    stats[client].mediaCount += readRegistry(project.projectId).length;
    stats[client].scriptCount += readScriptsRegistry(project.projectId).length;
  }

  cache = { stats, at: Date.now() };
  return stats;
}

export function invalidateClientStats(): void {
  cache = null;
}
