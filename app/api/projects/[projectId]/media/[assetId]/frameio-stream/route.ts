import { NextRequest, NextResponse } from 'next/server';
import { getFileMediaLinks } from '@/lib/services/frameio';
import { readRegistry } from '@/lib/store/media-registry';

type Params = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * GET /api/projects/[projectId]/media/[assetId]/frameio-stream
 *
 * Proxies the Frame.io CDN video stream through LPOS so the browser never
 * makes a cross-origin request to Frame.io directly. This avoids CORS /
 * CloudFront referrer restrictions and works from any machine on the LAN.
 *
 * - Forwards Range headers so video seeking works natively.
 * - Caches the CDN URL in-process for 5 minutes to avoid hammering the
 *   Frame.io API on every range request the browser makes while scrubbing.
 */

// ── CDN URL cache (per assetId) ───────────────────────────────────────────────

const urlCache = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function resolveStreamUrl(projectId: string, assetId: string): Promise<string | null> {
  const hit = urlCache.get(assetId);
  if (hit && Date.now() < hit.expiresAt) return hit.url;

  const assets        = readRegistry(projectId);
  const asset         = assets.find((a) => a.assetId === assetId);
  const frameioFileId = asset?.frameio?.assetId;
  if (!frameioFileId) return null;

  const links = await getFileMediaLinks(frameioFileId);
  const url   = links.highQualityUrl ?? links.efficientUrl ?? links.originalUrl;
  if (!url) return null;

  urlCache.set(assetId, { url, expiresAt: Date.now() + CACHE_TTL_MS });
  return url;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { projectId, assetId } = await params;

    const streamUrl = await resolveStreamUrl(projectId, assetId);

    if (!streamUrl) {
      return NextResponse.json(
        { error: 'No stream URL available yet — Frame.io may still be processing' },
        { status: 404 },
      );
    }

    // Forward Range header so the browser can seek / load metadata efficiently
    const fetchHeaders: Record<string, string> = {};
    const range = req.headers.get('range');
    if (range) fetchHeaders['Range'] = range;

    // Fetch the video bytes from Frame.io CDN on the server side
    const cdn = await fetch(streamUrl, { headers: fetchHeaders });

    // Build response headers — forward Content-Type, Length, Range info
    const resHeaders = new Headers();
    resHeaders.set('Content-Type',  cdn.headers.get('content-type')  ?? 'video/mp4');
    resHeaders.set('Accept-Ranges', 'bytes');
    resHeaders.set('Cache-Control', 'no-store');

    const contentLength = cdn.headers.get('content-length');
    const contentRange  = cdn.headers.get('content-range');
    if (contentLength) resHeaders.set('Content-Length', contentLength);
    if (contentRange)  resHeaders.set('Content-Range',  contentRange);

    return new NextResponse(cdn.body, { status: cdn.status, headers: resHeaders });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[frameio-stream]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
