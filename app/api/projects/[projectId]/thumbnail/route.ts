/**
 * GET /api/projects/[projectId]/thumbnail
 *
 * Returns a 307 redirect to the Frame.io CDN thumbnail for the first uploaded
 * asset in the project. Used by project cards on the projects page.
 *
 * 404 when: Frame.io not connected, no uploaded assets, or thumbnail unavailable.
 * Results are cached in memory for 30 minutes to avoid hammering the Frame.io API
 * on every page load.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readRegistry }              from '@/lib/store/media-registry';
import { getFileMediaLinks }         from '@/lib/services/frameio';
import { isConnected }               from '@/lib/services/frameio-tokens';

type Params = { params: Promise<{ projectId: string }> };

const cache    = new Map<string, { url: string; fetchedAt: number }>();
const CACHE_MS = 30 * 60 * 1000; // 30 minutes

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  if (!isConnected()) return new NextResponse(null, { status: 404 });

  // Find first asset that has been uploaded to Frame.io
  const assets  = readRegistry(projectId);
  const frameioAssetId = assets.find((a) => a.frameio?.assetId)?.frameio?.assetId ?? null;
  if (!frameioAssetId) return new NextResponse(null, { status: 404 });

  // Cache hit
  const cached = cache.get(frameioAssetId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return NextResponse.redirect(cached.url, { status: 307 });
  }

  // Fetch fresh from Frame.io
  try {
    const links = await getFileMediaLinks(frameioAssetId);
    const url   = links.thumbnailUrl;
    if (!url) return new NextResponse(null, { status: 404 });

    cache.set(frameioAssetId, { url, fetchedAt: Date.now() });
    return NextResponse.redirect(url, { status: 307 });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
