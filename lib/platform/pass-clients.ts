/**
 * Client association for Platform passes.
 *
 * A pass belongs to an LPOS client, keyed by client NAME — the same string key
 * projects and tasks use. The platform store keeps it as plain text (no FK into
 * lpos-core.sqlite) so the Platform section stays liftable; this module is the
 * LPOS-side glue that knows what the real clients are.
 */
import { getProjectStore, getClientStore } from '@/lib/services/container';
import { listPasses, setPassClient, type PlatformPass } from '@/lib/store/platform-pass-store';

/** Every known client name: clients with projects ∪ promoted clients (same
 *  union the Projects page shows), sorted A–Z. */
export function listClientNames(): string[] {
  const names = new Set<string>();
  for (const p of getProjectStore().getAll()) if (p.clientName) names.add(p.clientName);
  for (const c of getClientStore().getAll()) if (c.name) names.add(c.name);
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * Lazy, idempotent backfill: a legacy pass with no client but a default project
 * inherits that project's client. Runs on gallery load; a no-op once every
 * pass is filed (or has no default project to infer from).
 */
export function listPassesWithClientBackfill(): PlatformPass[] {
  const passes = listPasses();
  const missing = passes.filter((p) => !p.clientName && p.defaultProjectId);
  if (missing.length === 0) return passes;
  const projectStore = getProjectStore();
  return passes.map((p) => {
    if (p.clientName || !p.defaultProjectId) return p;
    const clientName = projectStore.getById(p.defaultProjectId)?.clientName;
    return clientName ? (setPassClient(p.id, clientName) ?? p) : p;
  });
}
