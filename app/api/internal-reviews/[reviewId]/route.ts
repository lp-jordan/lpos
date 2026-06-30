/**
 * Internal Review — viewing endpoint for the in-app review page.
 *
 * GET /api/internal-reviews/[reviewId]
 *   → { status: 'revoked', name }                    when revoked
 *   → { review, assets: MediaAsset[] }               when active
 *
 * Top-level (not project-scoped) because the review page only knows the
 * reviewId; the bundle row carries its own project_id. Authenticated by default
 * via middleware (any signed-in LPOS user). No Frame.io interaction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import {
  getInternalReview,
  getInternalReviewAssets,
} from '@/lib/store/internal-review-store';
import { getAsset } from '@/lib/store/media-registry';
import type { MediaAsset } from '@/lib/models/media-asset';

type Params = { params: Promise<{ reviewId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { reviewId } = await params;

  const review = getInternalReview(reviewId);
  if (!review) {
    return NextResponse.json({ error: 'Internal review not found.' }, { status: 404 });
  }

  if (review.status === 'revoked') {
    // 410 Gone — the page renders the gentle "expired" state from this.
    return NextResponse.json({ status: 'revoked', name: review.name }, { status: 410 });
  }

  // Resolve membership to full MediaAsset objects, preserving reel order and
  // silently dropping any asset that has since been deleted/moved.
  const assets: MediaAsset[] = getInternalReviewAssets(reviewId)
    .map((m) => getAsset(review.projectId, m.assetId))
    .filter((a): a is MediaAsset => a !== null);

  return NextResponse.json({ review, assets });
}
