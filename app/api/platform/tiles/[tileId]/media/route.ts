import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { setTileMedia, rememberProjectForTile } from '@/lib/store/platform-pass-store';
import { getAsset } from '@/lib/store/media-registry';
import { cloudflarePosterPreviewUrl } from '@/lib/models/media-asset';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

type LinkBody =
  | { kind: 'video'; projectId: string; assetId: string }
  | { kind: 'link'; url: string; title?: string };

export async function POST(req: NextRequest, { params }: { params: Promise<{ tileId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { tileId } = await params;
  const body = (await req.json().catch(() => ({}))) as LinkBody;

  if (body.kind === 'video') {
    if (!body.projectId || !body.assetId) return NextResponse.json({ error: 'projectId and assetId required' }, { status: 400 });
    const asset = getAsset(body.projectId, body.assetId);
    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    const tile = setTileMedia(tileId, {
      kind: 'video',
      mediaAssetId: asset.assetId,
      mediaProjectId: body.projectId,
      title: asset.name || asset.originalFilename,
      durationSec: asset.duration != null ? Math.round(asset.duration) : null,
      thumbUrl: cloudflarePosterPreviewUrl(asset.cloudflare),
      version: asset.frameio.version ?? null,
    });
    if (!tile) return NextResponse.json({ error: 'Tile not found' }, { status: 404 });
    rememberProjectForTile(tileId, body.projectId);
    return NextResponse.json({ tile });
  }

  if (body.kind === 'link') {
    if (!body.url?.trim()) return NextResponse.json({ error: 'url required' }, { status: 400 });
    const tile = setTileMedia(tileId, { kind: 'link', linkUrl: body.url.trim(), title: body.title?.trim() || body.url.trim() });
    if (!tile) return NextResponse.json({ error: 'Tile not found' }, { status: 404 });
    return NextResponse.json({ tile });
  }

  return NextResponse.json({ error: 'Unsupported media kind' }, { status: 400 });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ tileId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { tileId } = await params;
  const tile = setTileMedia(tileId, null);
  if (!tile) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ tile });
}
