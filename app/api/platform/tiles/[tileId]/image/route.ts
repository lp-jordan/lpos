import fs from 'node:fs';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTile, setTileImage, type TileImageSource } from '@/lib/store/platform-pass-store';
import { getAsset } from '@/lib/store/media-registry';
import { cloudflarePosterPreviewUrl } from '@/lib/models/media-asset';
import { TILE_IMG_DIR, tileImagePath } from '@/lib/platform/tile-image-store';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ tileId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { tileId } = await params;
  if (!getTile(tileId)) return NextResponse.json({ error: 'Tile not found' }, { status: 404 });

  let bytes: Buffer;
  let mime: string;
  let source: TileImageSource;

  if (req.headers.get('content-type')?.includes('application/json')) {
    // Use the linked video's poster frame as the source (fetched server-side → local).
    const tile = getTile(tileId)!;
    if (!tile.mediaProjectId || !tile.mediaAssetId) return NextResponse.json({ error: 'Tile is not linked to a video' }, { status: 400 });
    const asset = getAsset(tile.mediaProjectId, tile.mediaAssetId);
    const frameUrl = asset ? cloudflarePosterPreviewUrl(asset.cloudflare) : null;
    if (!frameUrl) return NextResponse.json({ error: 'Linked video has no available frame yet' }, { status: 400 });
    const r = await fetch(frameUrl);
    if (!r.ok) return NextResponse.json({ error: 'Could not fetch the video frame' }, { status: 502 });
    bytes = Buffer.from(await r.arrayBuffer());
    mime = r.headers.get('content-type') || 'image/jpeg';
    source = 'poster';
  } else {
    // Direct file upload (multipart/form-data, field name "file").
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: 'Image too large (max 15 MB)' }, { status: 413 });
    bytes = Buffer.from(await file.arrayBuffer());
    mime = file.type || 'image/jpeg';
    source = 'uploaded';
  }

  fs.mkdirSync(TILE_IMG_DIR, { recursive: true });
  fs.writeFileSync(tileImagePath(tileId), bytes);
  return NextResponse.json({ tile: setTileImage(tileId, mime, source) });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ tileId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { tileId } = await params;
  const tile = getTile(tileId);
  const p = tileImagePath(tileId);
  if (!tile?.imageMime || !fs.existsSync(p)) return NextResponse.json({ error: 'No image' }, { status: 404 });
  const buf = fs.readFileSync(p);
  return new Response(new Uint8Array(buf), {
    headers: { 'Content-Type': tile.imageMime, 'Cache-Control': 'private, max-age=60' },
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ tileId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { tileId } = await params;
  const p = tileImagePath(tileId);
  if (fs.existsSync(p)) fs.rmSync(p);
  return NextResponse.json({ tile: setTileImage(tileId, null) });
}
