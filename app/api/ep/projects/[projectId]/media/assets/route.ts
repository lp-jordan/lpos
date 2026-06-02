import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import { readRegistry } from '@/lib/store/media-registry';
import { requireEpToken } from '@/lib/services/ep-auth';

/**
 * GET /api/ep/projects/:projectId/media/assets  (X-EP-Token)
 *
 * Lightweight list of a project's media-registry assets, used by EditPanel's
 * pre-export version-conflict check AND (Phase 5c.3 — comment-marker pull) as
 * the asset-discovery source for the timeline↔asset tether.
 *
 * Each asset includes `editpanelRender` when it was rendered + uploaded via
 * editpanel — null otherwise (browser uploads, legacy imports). The orchestrator
 * filters by `editpanelRender !== null` and groups by `editpanelRender.timelineUid`
 * to identify which timelines have current uploads.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const assets = readRegistry(projectId).map((a) => ({
    assetId: a.assetId,
    name: a.name,
    originalFilename: a.originalFilename,
    editpanelRender: a.editpanelRender,
  }));

  return NextResponse.json({ assets });
}
