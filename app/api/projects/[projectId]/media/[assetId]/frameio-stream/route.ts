import { NextRequest, NextResponse } from 'next/server';
import { getFileMediaLinks } from '@/lib/services/frameio';
import { readRegistry } from '@/lib/store/media-registry';

type Params = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * GET /api/projects/[projectId]/media/[assetId]/frameio-stream
 *
 * Resolves the Frame.io CDN URL for this asset and issues a 302 redirect
 * so the browser fetches video bytes directly from Frame.io's CDN.
 *
 * Previously this route proxied the video stream through the LPOS Node.js
 * server. That approach saturated the server's I/O pipeline and exhausted
 * its memory budget for large files, making LPOS unreachable for all users
 * while theater mode was open (server process alive, no connections accepted).
 *
 * Direct redirect is safe because Frame.io CDN URLs are pre-signed
 * CloudFront/S3 URLs — authentication is in the URL signature, not the
 * request origin. The <video> element loads them without CORS enforcement.
 *
 * Caches the CDN URL for 5 minutes to avoid hammering the Frame.io API on
 * every Range request the browser makes while scrubbing.
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

    // 302 so the browser re-checks on each new session — CDN pre-signed URLs
    // rotate and must not be cached by the browser past their expiry.
    return NextResponse.redirect(streamUrl, {
      status: 302,
      headers: { 'Cache-Control': 'no-store' },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[frameio-stream]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
