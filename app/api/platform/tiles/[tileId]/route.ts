import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTile, updateTile, regenerateTile, deleteTile, type TilePatch } from '@/lib/store/platform-pass-store';
import { getTranscriptTextByAsset } from '@/lib/transcripts/store';
import { generateTitleFromTranscript, generateDescriptionFromTranscript } from '@/lib/passprep/generate-fields';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

/** Single-tile AI generation (Pass Prep per-row actions). Needs a linked video with a ready transcript. */
async function generateField(tileId: string, field: 'title' | 'description') {
  const existing = getTile(tileId);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!existing.mediaAssetId || !existing.mediaProjectId) {
    return NextResponse.json({ error: 'Link a video first.' }, { status: 400 });
  }
  const tr = getTranscriptTextByAsset(existing.mediaProjectId, existing.mediaAssetId);
  if (!tr) return NextResponse.json({ error: 'Transcript not ready for this video.' }, { status: 400 });
  try {
    const tile = field === 'title'
      ? updateTile(tileId, { title: await generateTitleFromTranscript({ transcript: tr.text, code: existing.sourceCode }), titleSource: 'ai', titleAssetId: existing.mediaAssetId })
      : updateTile(tileId, { description: await generateDescriptionFromTranscript({ transcript: tr.text, title: existing.title }), descriptionSource: 'ai', descriptionAssetId: existing.mediaAssetId });
    return NextResponse.json({ tile });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ tileId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { tileId } = await params;
  const body = (await req.json().catch(() => ({}))) as (TilePatch & { regenerate?: boolean; generateTitle?: boolean; generateDescription?: boolean });

  if (body.generateTitle) return generateField(tileId, 'title');
  if (body.generateDescription) return generateField(tileId, 'description');
  if (body.regenerate) {
    const tile = regenerateTile(tileId);
    if (!tile) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ tile });
  }

  // Direct human edits mark provenance 'manual' so a Pass Prep re-run never clobbers them.
  const patch: TilePatch = { ...body };
  if (body.titleSource === undefined && typeof body.title === 'string') patch.titleSource = 'manual';
  if (body.descriptionSource === undefined && typeof body.description === 'string') patch.descriptionSource = 'manual';

  const tile = updateTile(tileId, patch);
  if (!tile) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ tile });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ tileId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { tileId } = await params;
  deleteTile(tileId);
  return NextResponse.json({ ok: true });
}
