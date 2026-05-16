/**
 * Phase E cleanup: remove an asset from a deliverable.
 *
 * DELETE /api/projects/[projectId]/deliverables/[deliverableId]/assets/[assetId]
 *
 * Removes the asset from the underlying Frame.io share, then drops the local
 * deliverable_assets row. If the last asset is removed, the deliverable itself
 * stays around — the caller decides whether to delete the empty shell.
 *
 * Frame.io removal uses whichever Frame.io ref we stored locally (stack > file).
 * If Frame.io complains, we still drop the local row so the user isn't stuck
 * with phantom membership; a reconciler can clean up Frame.io-side later.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { removeFileFromShare } from '@/lib/services/frameio';
import {
  getDeliverable,
  getDeliverableAssets,
  removeAssetFromDeliverable,
} from '@/lib/store/deliverable-store';

type Params = { params: Promise<{ projectId: string; deliverableId: string; assetId: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { deliverableId, assetId } = await params;

  const deliverable = getDeliverable(deliverableId);
  if (!deliverable) {
    return NextResponse.json({ error: 'Deliverable not found' }, { status: 404 });
  }

  const members = getDeliverableAssets(deliverableId);
  const member = members.find((m) => m.assetId === assetId);
  if (!member) {
    return NextResponse.json({ error: 'Asset is not in this deliverable' }, { status: 404 });
  }

  const frameioRef = member.frameioStackId ?? member.frameioFileId;
  if (frameioRef) {
    try {
      await removeFileFromShare(deliverable.frameioShareId, frameioRef);
    } catch (err) {
      console.warn(
        `[deliverables] Frame.io remove failed for share ${deliverable.frameioShareId}, ref ${frameioRef} (continuing): ${(err as Error).message}`,
      );
    }
  }

  removeAssetFromDeliverable(deliverableId, assetId);
  return NextResponse.json({ ok: true });
}
