/**
 * Phase E cleanup: add an asset to an existing deliverable.
 *
 * POST /api/projects/[projectId]/deliverables/[deliverableId]/assets
 * Body: { assetId: string }
 *
 * Resolves the asset's preferred Frame.io ref (stack > file), pushes it to
 * the underlying Frame.io share via addFilesToShare, and records the row
 * locally. If the asset isn't on Frame.io yet, returns 400 — there's nothing
 * to attach.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getAsset } from '@/lib/store/media-registry';
import { addFilesToShare } from '@/lib/services/frameio';
import {
  getDeliverable,
  addAssetToDeliverable,
} from '@/lib/store/deliverable-store';

type Params = { params: Promise<{ projectId: string; deliverableId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { projectId, deliverableId } = await params;

  const body = await req.json().catch(() => ({})) as { assetId?: string };
  const assetId = body.assetId?.trim();
  if (!assetId) {
    return NextResponse.json({ error: 'assetId is required' }, { status: 400 });
  }

  const deliverable = getDeliverable(deliverableId);
  if (!deliverable) {
    return NextResponse.json({ error: 'Deliverable not found' }, { status: 404 });
  }

  const asset = getAsset(projectId, assetId);
  if (!asset) {
    return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  }
  const stackId = asset.frameio.stackId;
  const fileId = asset.frameio.assetId;
  const frameioRef = stackId ?? fileId;
  if (!frameioRef) {
    return NextResponse.json(
      { error: 'Asset is not on Frame.io yet — upload it first.' },
      { status: 400 },
    );
  }

  try {
    await addFilesToShare(deliverable.frameioShareId, [frameioRef]);
  } catch (err) {
    return NextResponse.json(
      { error: `Frame.io rejected the add: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  addAssetToDeliverable(deliverableId, {
    assetId,
    frameioStackId: stackId ?? null,
    frameioFileId: fileId ?? null,
  });

  return NextResponse.json({ ok: true });
}
