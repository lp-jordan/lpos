import { NextRequest, NextResponse } from 'next/server';
import { getAsset } from '@/lib/store/media-registry';
import {
  applyVideoSettings,
  getVideoDetails,
  isCloudflareStreamConfigured,
} from '@/lib/services/cloudflare-stream';
import { probeMediaInfo } from '@/lib/services/media-probe';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

// ── GET — read per-asset Cloudflare video settings ──────────────────────────
//
// Returns: { allowedOrigins: string[] }
//
// Currently surfaces only the fields used by the UI (Domain Restrictions
// modal). Extend the response as more settings need to be read.

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  if (!isCloudflareStreamConfigured()) {
    return NextResponse.json({ error: 'Cloudflare Stream is not configured on this host.' }, { status: 503 });
  }

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const uid = asset.cloudflare?.uid;
  if (!uid || asset.cloudflare?.status !== 'ready') {
    return NextResponse.json({ error: 'Asset does not have a ready Cloudflare Stream video.' }, { status: 400 });
  }

  try {
    const details = await getVideoDetails(uid);
    return NextResponse.json(details);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// ── POST — apply per-asset Cloudflare video settings ────────────────────────
//
// Body: { thumbnailFrameNumber?: number; allowedOrigins?: string[] }
//
// thumbnailFrameNumber: the specific video frame to use as the Cloudflare
// thumbnail (e.g. 24). The server probes fps/duration from the local file
// to convert this to a timestampPct before calling the Cloudflare API.
//
// allowedOrigins: full list of domains permitted to play this video. An
// empty array clears the restriction (Cloudflare default = play anywhere).

export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  if (!isCloudflareStreamConfigured()) {
    return NextResponse.json({ error: 'Cloudflare Stream is not configured on this host.' }, { status: 503 });
  }

  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const uid = asset.cloudflare?.uid;
  if (!uid || asset.cloudflare?.status !== 'ready') {
    return NextResponse.json({ error: 'Asset does not have a ready Cloudflare Stream video.' }, { status: 400 });
  }

  const body = await req.json() as { thumbnailFrameNumber?: number; allowedOrigins?: unknown };
  const settings: { thumbnailTimestampPct?: number; allowedOrigins?: string[] } = {};

  // ── allowedOrigins ────────────────────────────────────────────────────────
  if (body.allowedOrigins !== undefined) {
    if (!Array.isArray(body.allowedOrigins) || !body.allowedOrigins.every((o) => typeof o === 'string')) {
      return NextResponse.json({ error: 'allowedOrigins must be an array of strings.' }, { status: 400 });
    }
    // Normalise: trim, drop empties, dedupe. Cloudflare accepts bare hosts
    // (e.g. "example.com" or "*.example.com"); we don't enforce scheme.
    const normalized = Array.from(new Set(
      (body.allowedOrigins as string[]).map((o) => o.trim()).filter(Boolean),
    ));
    settings.allowedOrigins = normalized;
  }

  // ── thumbnailFrameNumber ──────────────────────────────────────────────────
  let thumbnailTimestampPct: number | undefined;
  if (typeof body.thumbnailFrameNumber === 'number') {
    if (body.thumbnailFrameNumber < 1) {
      return NextResponse.json({ error: 'thumbnailFrameNumber must be a positive integer.' }, { status: 400 });
    }

    let fps: number | null = null;
    let duration: number | null = asset.duration;

    if (asset.filePath) {
      try {
        const info = await probeMediaInfo(asset.filePath);
        fps = info.fps;
        duration = duration ?? info.duration;
      } catch {
        // Continue — will fail gracefully below if we can't compute pct
      }
    }

    if (!fps || !duration) {
      return NextResponse.json(
        { error: 'Could not determine fps or duration for this asset. Ensure the file is accessible on this host.' },
        { status: 422 },
      );
    }

    thumbnailTimestampPct = Math.max(0.001, Math.min(0.999, body.thumbnailFrameNumber / (fps * duration)));
    settings.thumbnailTimestampPct = thumbnailTimestampPct;
  }

  if (Object.keys(settings).length === 0) {
    return NextResponse.json({ error: 'No settings provided. Send thumbnailFrameNumber and/or allowedOrigins.' }, { status: 400 });
  }

  try {
    await applyVideoSettings(uid, settings);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    ...(thumbnailTimestampPct !== undefined ? { thumbnailTimestampPct } : {}),
    ...(settings.allowedOrigins !== undefined ? { allowedOrigins: settings.allowedOrigins } : {}),
  });
}
