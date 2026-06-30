/**
 * Internal Review page — /internal-review/[reviewId].
 *
 * Authenticated by default (middleware guards everything not allow-listed).
 * Renders the bundle's clips + reused MediaDetailPanel, themed near-black/gold.
 * See docs/internal-review-spec.md.
 */

import { InternalReviewView } from '@/components/internal-review/InternalReviewView';

export default async function InternalReviewPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { reviewId } = await params;
  return <InternalReviewView reviewId={reviewId} />;
}
