import { NextRequest, NextResponse } from 'next/server';
import { getFileMediaLinks } from '@/lib/services/frameio';
import { readRegistry } from '@/lib/store/media-registry';
import { listAssetVersionsWithFrameioFileId } from '@/lib/store/canonical-asset-store';

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
 * Uses high_quality.download_url (H.264 1080p transcode) so that .mov and
 * other non-web formats play in all browsers — Frame.io transcodes everything.
 * Falls back to original.inline_url if the transcode isn't ready yet.
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

// Sentinel stored in cache to indicate "use local /stream fallback"
const LOCAL_STREAM_SENTINEL = '__local__';

type ResolvedSource =
  | { kind: 'redirect'; url: string }
  | { kind: 'local' }
  | null;

async function resolveStreamUrl(
  projectId: string,
  assetId: string,
  versionId?: string | null,
): Promise<ResolvedSource> {
  const cacheKey = `${assetId}:${versionId ?? 'latest'}`;
  const hit = urlCache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) {
    return hit.url === LOCAL_STREAM_SENTINEL
      ? { kind: 'local' }
      : { kind: 'redirect', url: hit.url };
  }

  // ── Old-version playback ──────────────────────────────────────────────────
  // Only the CURRENT version lives on Cloudflare (the prior CF video is deleted
  // on each new version), so when a specific *older* version is requested we
  // serve its own Frame.io file from the version stack. A request for the
  // latest version falls through to the normal CF-first resolution below.
  if (versionId) {
    const versions = listAssetVersionsWithFrameioFileId(assetId);
    const latestId = versions[0]?.assetVersionId ?? null; // ordered version_number DESC
    if (latestId && versionId !== latestId) {
      const requested = versions.find((v) => v.assetVersionId === versionId);
      if (requested?.frameioFileId) {
        try {
          const links = await getFileMediaLinks(requested.frameioFileId);
          const url   = links.highQualityUrl ?? links.originalUrl;
          if (url) {
            urlCache.set(cacheKey, { url, expiresAt: Date.now() + CACHE_TTL_MS });
            return { kind: 'redirect', url };
          }
        } catch {
          // Fall through — this version isn't playable
        }
      }
      // Requested an older version with no usable Frame.io file → unavailable.
      return null;
    }
    // versionId === latest → continue to the current-version resolution.
  }

  const assets = readRegistry(projectId);
  const asset  = assets.find((a) => a.assetId === assetId);

  // ── 1. Cloudflare Stream HLS (primary playback layer) ─────────────────────
  // CF is the internal playback source once a video is fully processed. Gated
  // on status==='ready' so a still-uploading/encoding CF video falls through to
  // Frame.io during the processing window rather than serving a dead manifest.
  // (allowedOrigins does NOT gate direct HLS — verified — so this plays from the
  // LPOS origin regardless of a video's leaderpass-only origin lock.)
  //
  // Use the STORED hlsUrl (captured from the CF API at upload time, already
  // carrying the customer subdomain) rather than rebuilding from
  // CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN, which isn't reliably set in every env.
  const cf = asset?.cloudflare;
  if (cf?.uid && cf.status === 'ready' && cf.hlsUrl) {
    urlCache.set(cacheKey, { url: cf.hlsUrl, expiresAt: Date.now() + CACHE_TTL_MS });
    return { kind: 'redirect', url: cf.hlsUrl };
  }

  // ── 2. Frame.io (fallback while CF is still processing, or when not on CF) ─
  const frameioFileId = asset?.frameio?.assetId;
  if (frameioFileId) {
    try {
      const links = await getFileMediaLinks(frameioFileId);
      const url   = links.highQualityUrl ?? links.originalUrl;
      if (url) {
        urlCache.set(cacheKey, { url, expiresAt: Date.now() + CACHE_TTL_MS });
        return { kind: 'redirect', url };
      }
    } catch {
      // Fall through to next source
    }
  }

  // ── 3. Local disk stream ──────────────────────────────────────────────────
  if (asset?.filePath) {
    urlCache.set(cacheKey, { url: LOCAL_STREAM_SENTINEL, expiresAt: Date.now() + CACHE_TTL_MS });
    return { kind: 'local' };
  }

  return null;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { projectId, assetId } = await params;
    const isRaw     = req.nextUrl.searchParams.has('raw');
    const versionId = req.nextUrl.searchParams.get('version');

    const source = await resolveStreamUrl(projectId, assetId, versionId);

    if (!source) {
      return NextResponse.json(
        { error: 'No stream URL available yet — Frame.io may still be processing' },
        { status: 404 },
      );
    }

    if (source.kind === 'local') {
      const localUrl = `/api/projects/${projectId}/media/${assetId}/stream`;
      if (isRaw) return NextResponse.json({ url: localUrl });
      return NextResponse.redirect(new URL(localUrl, req.url), {
        status: 302,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // ?raw — return the CDN URL as JSON instead of redirecting.
    // Used by the hls.js client path to avoid the Firefox Origin:null CORS block
    // that occurs when hls.js follows a same-origin → cross-origin 302 redirect.
    if (isRaw) return NextResponse.json({ url: source.url });

    // 302 so the browser re-checks on each new session — CDN pre-signed URLs
    // rotate and must not be cached by the browser past their expiry.
    return NextResponse.redirect(source.url, {
      status: 302,
      headers: { 'Cache-Control': 'no-store' },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[frameio-stream]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
