/**
 * Internal Review bundles API (project-scoped management).
 *
 * GET  /api/projects/[projectId]/internal-reviews  — list internal reviews
 * POST /api/projects/[projectId]/internal-reviews  — create one
 *
 * Fully additive to the `deliverables` (Frame.io review link) system: no
 * Frame.io calls happen here. Internal reviews are LPOS-hosted, authenticated
 * review pages — see docs/internal-review-spec.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, getSession } from '@/lib/services/api-auth';
import {
  createInternalReview,
  listInternalReviewsForProject,
} from '@/lib/store/internal-review-store';
import { getAsset } from '@/lib/store/media-registry';

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { projectId } = await params;
  return NextResponse.json({
    internalReviews: listInternalReviewsForProject(projectId),
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId } = await params;

  let body: { assetIds?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'Name is required.' }, { status: 400 });

  const rawIds = Array.isArray(body.assetIds) ? body.assetIds : [];
  // Only keep assets that actually belong to this project — getAsset is scoped
  // by projectId, so this both validates membership and drops anything stale.
  const assetIds = rawIds
    .filter((id): id is string => typeof id === 'string')
    .filter((id) => getAsset(projectId, id) !== null);

  if (assetIds.length === 0) {
    return NextResponse.json(
      { error: 'Select at least one asset in this project.' },
      { status: 400 },
    );
  }

  const review = createInternalReview({
    projectId,
    name,
    createdBy: session.userId,
    assetIds,
  });

  return NextResponse.json({
    review,
    // Relative in-app path; the client makes it absolute for copying.
    url: `/internal-review/${review.reviewId}`,
  });
}
