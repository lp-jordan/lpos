/**
 * GET  /api/projects/[projectId]/media/[assetId]/frameio/comments
 *   → Fetch all comments for this asset from Frame.io
 *
 * POST /api/projects/[projectId]/media/[assetId]/frameio/comments
 *   → Post a new comment { text, timestamp? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getComments, postComment } from '@/lib/services/frameio';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const fileId = asset.frameio.assetId;
  if (!fileId) {
    return NextResponse.json({ comments: [] });
  }

  try {
    const comments = await getComments(fileId);
    patchAsset(projectId, assetId, { frameio: { commentCount: comments.length } });
    return NextResponse.json({ comments });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const fileId = asset.frameio.assetId;
  if (!fileId) {
    return NextResponse.json({ error: 'Asset has not been uploaded to Frame.io yet' }, { status: 400 });
  }

  const body = await req.json() as { text?: string; timestamp?: number | null };
  if (!body.text?.trim()) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  try {
    const comment = await postComment(fileId, body.text.trim(), body.timestamp ?? null);
    patchAsset(projectId, assetId, {
      frameio: { commentCount: asset.frameio.commentCount + 1 },
    });
    return NextResponse.json({ comment }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
