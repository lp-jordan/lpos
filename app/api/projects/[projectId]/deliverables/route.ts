/**
 * Phase E: Deliverables API.
 *
 * GET  /api/projects/[projectId]/deliverables           — list (any signed-in user)
 * POST /api/projects/[projectId]/deliverables           — create (signed-in user)
 *
 * The POST path drives every "create a share link" entry point in the UI:
 * MediaTab bulk bar, MediaDetailPanel "Share", and the Review Links panel's
 * "+ New" button. They all post the same shape.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, getSession } from '@/lib/services/api-auth';
import { listDeliverablesForProject } from '@/lib/store/deliverable-store';
import { createDeliverableForAssets } from '@/lib/services/deliverable-publish';
import type { DeliverableSettings } from '@/lib/models/deliverable';

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { projectId } = await params;
  return NextResponse.json({
    deliverables: listDeliverablesForProject(projectId),
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId } = await params;
  const body = await req.json().catch(() => ({})) as {
    assetIds?: string[];
    name?: string;
    expiresAt?: string | null;
    settings?: DeliverableSettings;
  };

  const assetIds = Array.isArray(body.assetIds) ? body.assetIds : [];
  const name = body.name?.trim() ?? '';
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (assetIds.length === 0) {
    return NextResponse.json({ error: 'assetIds must contain at least one asset' }, { status: 400 });
  }

  try {
    const result = await createDeliverableForAssets({
      projectId,
      assetIds,
      name,
      createdBy: session.userId,
      expiresAt: body.expiresAt ?? null,
      settings: body.settings,
    });
    return NextResponse.json(
      {
        deliverable: result.deliverable,
        skippedAssetIds: result.skippedAssetIds,
        shareUrl: result.share.shareUrl,
      },
      { status: 201 },
    );
  } catch (err) {
    const message = (err as Error).message;
    console.error('[deliverables POST] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
