import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { readRegistry } from '@/lib/store/media-registry';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const timeParam = req.nextUrl.searchParams.get('time');

  // ── Scrub thumbnail: redirect to Cloudflare Stream at the requested timecode ─
  if (timeParam !== null) {
    const t = Math.max(0, parseFloat(timeParam) || 0);
    const assets = readRegistry(projectId);
    const asset  = assets.find(a => a.assetId === assetId);
    const cfUid  = asset?.cloudflare?.uid;
    const sub    = process.env.CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN?.trim();
    if (cfUid && sub) {
      const url = `https://customer-${sub}.cloudflarestream.com/${cfUid}/thumbnails/thumbnail.jpg?time=${Math.round(t)}s&width=160&height=90`;
      return NextResponse.redirect(url, {
        status: 302,
        headers: { 'Cache-Control': 'public, max-age=3600' },
      });
    }
    return new NextResponse(null, { status: 404 });
  }

  // ── Static asset thumbnail: serve local .thumb.jpg ────────────────────────
  try {
    const mediaDir = resolveProjectMediaStorageDir(projectId);
    const thumbPath = path.join(mediaDir, `${assetId}.thumb.jpg`);

    if (!fs.existsSync(thumbPath)) {
      return new NextResponse(null, { status: 404 });
    }

    const buffer = await fs.promises.readFile(thumbPath);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
