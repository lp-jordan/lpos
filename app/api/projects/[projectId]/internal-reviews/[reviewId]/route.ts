/**
 * Internal Review bundle — single-bundle management.
 *
 * PATCH  /api/projects/[projectId]/internal-reviews/[reviewId]
 *        body: { name?, status?: 'active' | 'revoked', assetIds?: string[] }
 *        — rename, revoke/reactivate, and/or replace asset membership.
 * DELETE /api/projects/[projectId]/internal-reviews/[reviewId]  — hard delete.
 *
 * No Frame.io interaction — see docs/internal-review-spec.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import {
  getInternalReview,
  getInternalReviewWithAssets,
  updateInternalReview,
  setInternalReviewAssets,
  deleteInternalReview,
} from '@/lib/store/internal-review-store';
import { getAsset } from '@/lib/store/media-registry';

type Params = { params: Promise<{ projectId: string; reviewId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { projectId, reviewId } = await params;

  const existing = getInternalReview(reviewId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: 'Internal review not found.' }, { status: 404 });
  }

  let body: { name?: unknown; status?: unknown; assetIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  // Asset-membership replacement (validated against this project).
  if (Array.isArray(body.assetIds)) {
    const assetIds = body.assetIds
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => getAsset(projectId, id) !== null);
    if (assetIds.length === 0) {
      return NextResponse.json(
        { error: 'An internal review must contain at least one asset.' },
        { status: 400 },
      );
    }
    setInternalReviewAssets(reviewId, assetIds);
  }

  // Name / status.
  const patch: { name?: string; status?: 'active' | 'revoked' } = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (body.status === 'active' || body.status === 'revoked') patch.status = body.status;
  if (patch.name !== undefined || patch.status !== undefined) {
    updateInternalReview(reviewId, patch);
  }

  return NextResponse.json({ review: getInternalReviewWithAssets(reviewId) });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { projectId, reviewId } = await params;

  const existing = getInternalReview(reviewId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: 'Internal review not found.' }, { status: 404 });
  }

  deleteInternalReview(reviewId);
  return NextResponse.json({ ok: true });
}
