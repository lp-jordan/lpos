import { NextResponse } from 'next/server';
import { listShares } from '@/lib/services/frameio';
import type { FrameIOShare } from '@/lib/services/frameio';
import { getAllShareAssets } from '@/lib/store/share-assets-store';
import { getProjectStore } from '@/lib/services/container';

export interface GlobalShareProject {
  projectId:   string;
  projectName: string;
  clientName:  string;
  shares:      FrameIOShare[];
}

/**
 * GET /api/shares
 *
 * Returns all share links grouped by project.
 * Shares that have been created through LPOS are assigned to their project via
 * the local store. Shares not tracked in any project's local store are placed
 * in a synthetic "Unassigned" group so they remain visible.
 *
 * Calls Frame.io once, then cross-references against every project's local store.
 */
export async function GET() {
  try {
    const projects   = getProjectStore().getAll();
    const allFioShares = await listShares();

    // Only care about real shares — not per-asset auto-review links
    const relevantShares = allFioShares.filter((s) => !s.name.startsWith('Review — '));

    // Build map of shareId → projectId for shares tracked in a local store
    const shareProjectMap = new Map<string, string>();
    for (const project of projects) {
      const localShares = getAllShareAssets(project.projectId);
      for (const shareId of Object.keys(localShares)) {
        shareProjectMap.set(shareId, project.projectId);
      }
    }

    // Group shares by their owning project
    const grouped = new Map<string, FrameIOShare[]>();
    for (const share of relevantShares) {
      const ownerProjectId = shareProjectMap.get(share.id) ?? '__unassigned__';
      const arr = grouped.get(ownerProjectId) ?? [];
      arr.push(share);
      grouped.set(ownerProjectId, arr);
    }

    const result: GlobalShareProject[] = [];

    // Assigned shares — enrich with fileCount from local store
    for (const project of projects) {
      const shares = grouped.get(project.projectId);
      if (!shares?.length) continue;

      const localShares = getAllShareAssets(project.projectId);
      const enriched = shares.map((s) => ({
        ...s,
        fileCount: (localShares[s.id]?.length ?? 0) > 0 ? localShares[s.id].length : null,
      }));
      enriched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      result.push({
        projectId:   project.projectId,
        projectName: project.name,
        clientName:  project.clientName,
        shares:      enriched,
      });
    }

    // Unassigned shares — not in any project's local store
    const unassigned = grouped.get('__unassigned__');
    if (unassigned?.length) {
      const sorted = [...unassigned].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      result.push({
        projectId:   '__unassigned__',
        projectName: 'Unassigned',
        clientName:  '',
        shares:      sorted,
      });
    }

    result.sort((a, b) => {
      // Unassigned always last
      if (a.projectId === '__unassigned__') return 1;
      if (b.projectId === '__unassigned__') return -1;
      return (
        a.clientName.localeCompare(b.clientName, undefined, { numeric: true }) ||
        a.projectName.localeCompare(b.projectName, undefined, { numeric: true })
      );
    });

    return NextResponse.json({ projects: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[shares global GET] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
