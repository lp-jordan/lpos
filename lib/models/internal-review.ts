/**
 * Internal Review bundles — LPOS-hosted, authenticated review pages.
 *
 * An internal review is a named collection of project assets that the internal
 * team watches and comments on inside LPOS, bypassing Frame.io entirely. It is
 * fully additive to and independent of the `deliverables` (Frame.io review link)
 * and delivery-link systems — see docs/internal-review-spec.md.
 *
 * Comments are NOT modelled here: the review page reuses the normal
 * media_comments thread per asset, so feedback flows both ways with the regular
 * media page. Revocation is on-demand via `status` (no time-based expiry).
 */

export type InternalReviewStatus = 'active' | 'revoked';

export interface InternalReview {
  reviewId: string;
  projectId: string;
  name: string;
  status: InternalReviewStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface InternalReviewAsset {
  reviewId: string;
  assetId: string;
  /** Reel order on the review page. */
  position: number;
  addedAt: string;
}

export interface InternalReviewWithAssets extends InternalReview {
  assets: InternalReviewAsset[];
  assetCount: number;
}
