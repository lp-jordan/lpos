/**
 * /api/projects/[projectId]/media/[assetId]/frameio
 *
 * POST — Trigger a Frame.io upload for this asset.
 *        Runs upload in the background so the response returns immediately.
 *        Sets frameio.status = 'uploading' then 'in_review' on completion.
 *
 * GET  — Return current frameio sub-record (for polling).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { triggerFrameIOUpload } from '@/lib/services/frameio-upload';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

// ── GET — current Frame.io status ─────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  return NextResponse.json({ frameio: asset.frameio });
}

// ── POST — start Frame.io upload ──────────────────────────────────────────────

export async function POST(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  if (!asset.filePath) {
    return NextResponse.json({ error: 'No local file path — cannot upload to Frame.io' }, { status: 400 });
  }

  if (asset.frameio.status === 'uploading') {
    return NextResponse.json({ error: 'Upload already in progress' }, { status: 409 });
  }

  // Reset error state and trigger upload via shared service
  patchAsset(projectId, assetId, { frameio: { status: 'none', lastError: null } });
  triggerFrameIOUpload(projectId, assetId);

  return NextResponse.json({ ok: true, status: 'uploading' });
}
