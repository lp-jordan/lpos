import { NextRequest, NextResponse } from 'next/server';
import { getAsset } from '@/lib/store/media-registry';
import { applyVideoSettings, isCloudflareStreamConfigured } from '@/lib/services/cloudflare-stream';
import { probeMediaInfo } from '@/lib/services/media-probe';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

// ── POST — apply per-asset Cloudflare video settings ────────────────────────
//
// Body: { thumbnailFrameNumber?: number }
//
// thumbnailFrameNumber: the specific video frame to use as the Cloudflare
// thumbnail (e.g. 24). The server probes fps/duration from the local file
// to convert this to a timestampPct before calling the Cloudflare API.

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

  const body = await req.json() as { thumbnailFrameNumber?: number };
  const frameNumber = typeof body.thumbnailFrameNumber === 'number' ? body.thumbnailFrameNumber : null;

  if (frameNumber === null || frameNumber < 1) {
    return NextResponse.json({ error: 'thumbnailFrameNumber must be a positive integer.' }, { status: 400 });
  }

  // Probe fps and duration from the local file.
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

  const pct = Math.max(0.001, Math.min(0.999, frameNumber / (fps * duration)));

  try {
    await applyVideoSettings(uid, { thumbnailTimestampPct: pct });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json({ ok: true, thumbnailTimestampPct: pct });
}
