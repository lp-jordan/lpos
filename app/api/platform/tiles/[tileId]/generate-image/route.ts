import fs from 'node:fs';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTile, setTileImage } from '@/lib/store/platform-pass-store';
import { TILE_IMG_DIR, tileImagePath } from '@/lib/platform/tile-image-store';
import { buildImagePrompt } from '@/lib/platform/image-style';
import { generateTileImage } from '@/lib/platform/image-generate';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

// Generate a hero image for a tile from its title + description (or an explicit
// prompt override) and store it in the same local seam as uploaded images, so it
// flows through the existing duotone renderer + export untouched. Never touches
// the Cloudflare video poster.
export async function POST(req: NextRequest, { params }: { params: Promise<{ tileId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { tileId } = await params;
  const tile = getTile(tileId);
  if (!tile) return NextResponse.json({ error: 'Tile not found' }, { status: 404 });
  if (tile.archetype !== 'duotone' && tile.archetype !== 'geometric' && tile.archetype !== 'hero') {
    return NextResponse.json({ error: 'This tile style has no image slot' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { prompt?: string };
  const override = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const prompt = override || buildImagePrompt(tile.title, tile.description);

  let img;
  try {
    img = await generateTileImage(prompt);
  } catch (e) {
    // e.g. a content-policy refusal from the live model — keep the existing art.
    return NextResponse.json({ error: `Generation failed: ${(e as Error).message}` }, { status: 502 });
  }

  fs.mkdirSync(TILE_IMG_DIR, { recursive: true });
  fs.writeFileSync(tileImagePath(tileId), img.bytes);
  const updated = setTileImage(tileId, img.mime, 'generated', prompt);
  return NextResponse.json({ tile: updated, prompt, placeholder: img.placeholder });
}
