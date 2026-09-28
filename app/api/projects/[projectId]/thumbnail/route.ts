/**
 * GET /api/projects/[projectId]/thumbnail
 *
 * Returns a 307 redirect to the Frame.io CDN thumbnail for the first uploaded
 * asset in the project. Used by project cards on the projects page.
 *
 * Falls back to the first asset's Cloudflare Stream thumbnail when no asset is on
 * Frame.io (e.g. automatic Frame.io upload switched off) or Frame.io is disconnected.
 *
 * 404 when neither source has a thumbnail.
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

  const assets  = readRegistry(projectId);
  const cloudflareFallback = () => {
    const url = assets.find((a) => a.cloudflare?.status === 'ready' && a.cloudflare.thumbnailUrl)?.cloudflare?.thumbnailUrl;
    return url ? NextResponse.redirect(url, { status: 307 }) : new NextResponse(null, { status: 404 });
  };

  // Find first asset that has been uploaded to Frame.io
  const frameioAssetId = isConnected() ? assets.find((a) => a.frameio?.assetId)?.frameio?.assetId ?? null : null;
  if (!frameioAssetId) return cloudflareFallback();

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
