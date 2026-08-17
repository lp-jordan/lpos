import { NextRequest, NextResponse } from 'next/server';
import { getAsset } from '@/lib/store/media-registry';
import { describeSkip, republishCaptions } from '@/lib/services/caption-republish';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * Re-push an already-saved transcript's VTT to Cloudflare without editing it —
 * the editor's Retry, for when a save landed on disk but the caption upload
 * failed (network blip, Cloudflare 5xx, video still processing at the time).
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, assetId } = await params;
    const body = await req.json().catch(() => ({})) as { lang?: 'en' | 'es' };
    const lang = body.lang === 'es' ? 'es' : 'en';

    const asset = getAsset(projectId, assetId);
    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

    const info = lang === 'es' ? asset.transcriptionEs : asset.transcription;
    const jobId = info?.status === 'done' ? info.jobId : null;
    if (!jobId) return NextResponse.json({ error: `No completed ${lang} transcript for this asset` }, { status: 404 });

    const push = await republishCaptions(projectId, assetId, jobId, lang);
    return NextResponse.json({
      lang,
      cloudflare: push,
      cloudflareMessage: push.status === 'skipped' ? describeSkip(push.reason) : null,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
