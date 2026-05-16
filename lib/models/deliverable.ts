/**
 * Phase E: Deliverable model.
 *
 * A "deliverable" is one named, project-scoped Frame.io share that points at
 * one or more assets. Each asset on the deliverable is tracked by its Frame.io
 * stack ID (preferred — Frame.io shares pointing at a stack auto-resolve to
 * the stack's head_version, so subsequent uploads propagate without any
 * re-pointing on our side) or fallback file ID (for assets that don't have a
 * stack yet — e.g. the asset has never been re-uploaded so no stack exists).
 *
 * Vocabulary:
 *   - "Review link" = a deliverable rendered as a Frame.io URL. Internal-facing,
 *     for the team to see in-progress edits or share with clients for review.
 *   - "Delivery link" = the existing R2-backed final-handoff system (delivery
 *     route + zip downloads). NOT a deliverable in this model. Separate path.
 */

export interface DeliverableSettings {
  downloading_enabled?: boolean;
  passphrase?: string | null;
  // Reserved for future Frame.io share knobs (commenting_enabled etc.). The
  // settings_json column is open-ended so we don't need a migration to add
  // a new knob — just thread it through createShareLink + persist.
}

export interface Deliverable {
  deliverableId: string;
  projectId: string;
  name: string;
  frameioShareId: string;
  shortUrl: string;
  expiresAt: string | null;
  settings: DeliverableSettings;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableAsset {
  deliverableId: string;
  assetId: string;
  // One of these two is non-null. Stack ID is preferred (auto-resolving share);
  // file ID is the fallback when no stack exists yet for this asset.
  frameioStackId: string | null;
  frameioFileId: string | null;
  addedAt: string;
}

/** A deliverable with its asset members. Used by the list view. */
export interface DeliverableWithAssets extends Deliverable {
  assets: DeliverableAsset[];
  assetCount: number;
}
