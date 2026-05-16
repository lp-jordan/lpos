/**
 * Phase E: per-asset deliverables list.
 *
 * GET /api/projects/[projectId]/media/[assetId]/deliverables
 *
 * Returns every deliverable that currently contains this asset, with their
 * names and short URLs. Used by MediaDetailPanel's Frame.io dropdown to show
 * which review links a viewer can hand off.
 *
 * Replaces the legacy GET /api/projects/[projectId]/media/[assetId]/shares
 * which read from asset_share_links — the legacy route still exists but is
 * dead from the UI side.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { findDeliverablesContainingAsset } from '@/lib/store/deliverable-store';

type Params = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { assetId } = await params;

  const found = findDeliverablesContainingAsset(assetId);
  return NextResponse.json({
    deliverables: found.map(({ deliverable, asset }) => ({
      deliverableId: deliverable.deliverableId,
      name: deliverable.name,
      shortUrl: deliverable.shortUrl,
      createdAt: deliverable.createdAt,
      frameioStackId: asset.frameioStackId,
      frameioFileId: asset.frameioFileId,
    })),
  });
}
