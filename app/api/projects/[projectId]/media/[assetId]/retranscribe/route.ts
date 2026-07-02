import { NextRequest, NextResponse } from 'next/server';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getTranscripterService } from '@/lib/services/container';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function POST(_req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, assetId } = await params;
    const asset = getAsset(projectId, assetId);
    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    if (!asset.filePath) {
      return NextResponse.json({ error: 'No file path — update the asset path before re-transcribing' }, { status: 400 });
    }

    // Pass the known media duration so the length-aware timeout (if enabled in
    // admin Settings) scales for long videos — the fixed floor otherwise trips
    // on >30–45 min files under large-v3.
    const durationSec = typeof asset.duration === 'number' && asset.duration > 0 ? asset.duration : undefined;
    const job = getTranscripterService().enqueue(projectId, asset.filePath, assetId, undefined, durationSec);

    patchAsset(projectId, assetId, {
      transcription: { status: 'queued', jobId: job.jobId, completedAt: null },
    });

    return NextResponse.json({ jobId: job.jobId });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
