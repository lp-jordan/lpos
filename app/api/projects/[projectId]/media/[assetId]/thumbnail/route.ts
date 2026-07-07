import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { readRegistry, getAsset } from '@/lib/store/media-registry';
import { extractThumbnail } from '@/lib/services/media-probe';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const timeParam = req.nextUrl.searchParams.get('time');

  // ── Scrub thumbnail: redirect to Cloudflare Stream at the requested timecode ─
  if (timeParam !== null) {
    const t = Math.max(0, parseFloat(timeParam) || 0);
    const assets = readRegistry(projectId);
    const asset  = assets.find(a => a.assetId === assetId);
    // Use the stored thumbnailUrl (from the CF API, already carrying the customer
    // subdomain, e.g. https://customer-xxx.cloudflarestream.com/<uid>/thumbnails/
    // thumbnail.jpg) rather than rebuilding from CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN,
    // which isn't reliably set in every env.
    const cfThumb = asset?.cloudflare?.thumbnailUrl;
    if (cfThumb) {
      const base = cfThumb.split('?')[0];
      const url = `${base}?time=${Math.round(t)}s&width=160&height=90`;
      return NextResponse.redirect(url, {
        status: 302,
        headers: { 'Cache-Control': 'public, max-age=3600' },
      });
    }
    return new NextResponse(null, { status: 404 });
  }

  // ── Static asset thumbnail: serve local .thumb.jpg ────────────────────────
  // The thumbnail lives next to the media file — same directory as the asset's
  // stored `filePath` — NOT under resolveProjectMediaStorageDir(projectId).
  // When an asset is moved between projects only its DB `project_id` changes;
  // the bytes on disk stay put (which is why the /stream route, keyed off the
  // stored absolute filePath, keeps working post-move). Deriving the thumb dir
  // from filePath therefore resolves correctly for both current and
  // already-moved assets. We fall back to the project media dir for assets that
  // predate a stored filePath, and regenerate the thumb on the fly when it's
  // missing but the source media is still on disk.
  try {
    const asset = getAsset(projectId, assetId);

    let thumbPath: string;
    if (asset?.filePath) {
      thumbPath = path.join(path.dirname(asset.filePath), `${assetId}.thumb.jpg`);
    } else {
      thumbPath = path.join(resolveProjectMediaStorageDir(projectId), `${assetId}.thumb.jpg`);
    }

    if (!fs.existsSync(thumbPath) && asset?.filePath && fs.existsSync(asset.filePath)) {
      await extractThumbnail(asset.filePath, thumbPath);
    }

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
