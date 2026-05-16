/**
 * GET    /api/admin/cloudflare-orphans          — list active orphan candidates
 * POST   /api/admin/cloudflare-orphans/reconcile — trigger an immediate reconcile pass
 *
 * Admin-only. Detection is automatic via the scheduled reconciler; this endpoint
 * lets an admin force a fresh sweep on demand.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { listActiveOrphans, type CloudflareOrphan } from '@/lib/store/cloudflare-orphan-store';
import { getCloudflareOrphanReconciler } from '@/lib/services/container';
import { getCoreDb } from '@/lib/store/core-db';

interface EnrichedOrphan extends CloudflareOrphan {
  projectName: string | null;
  clientName: string | null;
}

function enrichWithProjects(orphans: CloudflareOrphan[]): EnrichedOrphan[] {
  const projectIds = [...new Set(orphans.map((o) => o.projectIdWhenOrphaned).filter((p): p is string => !!p))];
  if (projectIds.length === 0) {
    return orphans.map((o) => ({ ...o, projectName: null, clientName: null }));
  }
  const placeholders = projectIds.map(() => '?').join(',');
  const rows = getCoreDb()
    .prepare(`SELECT project_id, name, client_name FROM projects WHERE project_id IN (${placeholders})`)
    .all(...projectIds) as Array<{ project_id: string; name: string; client_name: string }>;
  const byId = new Map(rows.map((r) => [r.project_id, r]));
  return orphans.map((o) => {
    const proj = o.projectIdWhenOrphaned ? byId.get(o.projectIdWhenOrphaned) : undefined;
    return {
      ...o,
      projectName: proj?.name ?? null,
      clientName: proj?.client_name ?? null,
    };
  });
}

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;
  return NextResponse.json({ orphans: enrichWithProjects(listActiveOrphans()) });
}

export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;
  const reconciler = getCloudflareOrphanReconciler();
  if (!reconciler) {
    return NextResponse.json({ error: 'Reconciler service is not initialised.' }, { status: 503 });
  }
  const summary = await reconciler.runOnce();
  return NextResponse.json({ summary, orphans: enrichWithProjects(listActiveOrphans()) });
}
