import { NextRequest, NextResponse } from 'next/server';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getTranscripterService } from '@/lib/services/container';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * Start (or restart) an additive Spanish transcription pass for a single asset.
 * Coexists with the English transcript — drives asset.transcriptionEs and, on
 * completion, attaches an 'es' caption track to the asset's Cloudflare video
 * (a no-op if the asset isn't on Cloudflare). See enqueueSpanish.
 */
export async function POST(_req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, assetId } = await params;
    const asset = getAsset(projectId, assetId);
    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    if (!asset.filePath) {
      return NextResponse.json({ error: 'No file path — update the asset path before transcribing' }, { status: 400 });
    }

    const durationSec = typeof asset.duration === 'number' && asset.duration > 0 ? asset.duration : undefined;
    const job = getTranscripterService().enqueueSpanish(projectId, asset.filePath, assetId, {
      durationSec,
      // Friendly name for the pipeline tray + transcripts list; without it the job
      // falls back to the UUID-style stored filename (basename of filePath).
      displayName: asset.originalFilename ?? asset.name,
    });

    patchAsset(projectId, assetId, {
      transcriptionEs: { status: 'queued', jobId: job.jobId, completedAt: null },
    });

    return NextResponse.json({ jobId: job.jobId });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
