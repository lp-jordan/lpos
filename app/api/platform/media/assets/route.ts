import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { readRegistry } from '@/lib/store/media-registry';
import { cloudflarePosterPreviewUrl } from '@/lib/models/media-asset';

/** Media assets for a project, shaped for the tile picker. */
export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  if (!(await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });

  const assets = readRegistry(projectId).map((a) => ({
    assetId: a.assetId,
    name: a.name || a.originalFilename,
    durationSec: a.duration != null ? Math.round(a.duration) : null,
    thumbUrl: cloudflarePosterPreviewUrl(a.cloudflare),
    ready: !!a.cloudflare.hlsUrl,
  }));
  return NextResponse.json({ assets });
}
