import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getProjectStore } from '@/lib/services/container';
import { moveAssetsBetweenProjects } from '@/lib/store/asset-move-store';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import { getUserById } from '@/lib/store/user-store';

/**
 * POST /api/projects/[projectId]/media/move
 *
 * Reassigns one or more assets from this project (the URL one) to another.
 * Body: `{ assetIds: string[], targetProjectId: string }`.
 *
 * Response: `{ moved: string[], failed: Array<{assetId, reason}> }`.
 *
 * Records ONE asset.moved activity event PER successful asset, scoped to
 * the TARGET project so the new home gets an "arrival" entry. Historical
 * events for the moved asset are intentionally left at the SOURCE so the
 * source's feed still shows the asset's pre-move story — see
 * asset-move-store.ts for details. Net effect: the source's history ends
 * at "asset was here, here's what happened"; the target's history begins
 * with "asset moved in from X, here's what's happened since."
 *
 * Frame.io state is intentionally NOT moved. The MoveAssetsModal surfaces
 * that to the user before they confirm.
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId: fromProjectId } = await params;
  const body = (await req.json()) as { assetIds?: unknown; targetProjectId?: unknown };

  if (!Array.isArray(body.assetIds) || body.assetIds.some((id) => typeof id !== 'string')) {
    return NextResponse.json({ error: 'assetIds must be an array of strings.' }, { status: 400 });
  }
  if (typeof body.targetProjectId !== 'string' || !body.targetProjectId) {
    return NextResponse.json({ error: 'targetProjectId is required.' }, { status: 400 });
  }
  const assetIds = body.assetIds as string[];
  const toProjectId = body.targetProjectId;

  if (fromProjectId === toProjectId) {
    return NextResponse.json({ error: 'Source and target project are the same.' }, { status: 400 });
  }

  // Validate both projects exist + neither is archived (a moved asset
  // landing in an archived project is a UX trap, not a feature).
  const projectStore = getProjectStore();
  const fromProject = projectStore.getById(fromProjectId);
  const toProject = projectStore.getById(toProjectId);
  if (!fromProject) return NextResponse.json({ error: 'Source project not found.' }, { status: 404 });
  if (!toProject) return NextResponse.json({ error: 'Target project not found.' }, { status: 404 });
  if (toProject.archived) {
    return NextResponse.json({ error: 'Target project is archived.' }, { status: 400 });
  }

  const result = moveAssetsBetweenProjects({
    fromProjectId,
    toProjectId,
    assetIds,
  });

  // Record one asset.moved event per successful move. This is the audit
  // anchor — even after historical events for the asset are rewritten to
  // the new project's id, the move event itself encodes both ends.
  const actor = getUserById(session.userId);
  const actorName = actor?.name ?? undefined;
  const now = new Date().toISOString();
  for (const assetId of result.movedAssetIds) {
    recordActivity({
      actor_type: 'user',
      actor_id: session.userId,
      actor_display: actorName ?? null,
      occurred_at: now,
      event_type: 'asset.moved',
      lifecycle_phase: 'updated',
      source_kind: 'api',
      visibility: 'user_timeline',
      title: `Asset moved from ${fromProject.name} to ${toProject.name}`,
      summary: `Reassigned via Internal Media → Move to project…`,
      project_id: toProjectId,
      client_id: toProject.clientName ?? null,
      asset_id: assetId,
      details_json: {
        from_project_id: fromProjectId,
        to_project_id: toProjectId,
        from_project_name: fromProject.name,
        to_project_name: toProject.name,
      },
    });
  }

  return NextResponse.json({
    moved: result.movedAssetIds,
    failed: result.failedAssetIds,
  });
}
