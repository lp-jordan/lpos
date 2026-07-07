import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getProjectStore } from '@/lib/services/container';
import { findMoveCollision } from '@/lib/store/canonical-asset-store';

/**
 * POST /api/projects/[projectId]/media/move/preflight
 *
 * Dry-run check for a move of `assetIds` from this project (the URL one) into
 * `targetProjectId`. Reports name collisions in the target so the MoveAssetsModal
 * can ask the editor how to resolve each one BEFORE committing the move.
 *
 * Body: `{ assetIds: string[], targetProjectId: string }`.
 * Response: `{ collisions: MoveCollision[] }` — one entry per moving asset whose
 * (normalized) name already exists in the target project. Assets with no collision
 * are omitted; an empty array means the move can proceed unattended.
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

  const projectStore = getProjectStore();
  if (!projectStore.getById(fromProjectId)) {
    return NextResponse.json({ error: 'Source project not found.' }, { status: 404 });
  }
  const toProject = projectStore.getById(toProjectId);
  if (!toProject) return NextResponse.json({ error: 'Target project not found.' }, { status: 404 });
  if (toProject.archived) {
    return NextResponse.json({ error: 'Target project is archived.' }, { status: 400 });
  }

  const collisions = assetIds
    .map((assetId) => findMoveCollision(toProjectId, assetId))
    .filter((c): c is NonNullable<typeof c> => c !== null);

  return NextResponse.json({ collisions });
}
