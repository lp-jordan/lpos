import { NextRequest, NextResponse } from 'next/server';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getTranscripterService } from '@/lib/services/container';

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * Batch-start additive Spanish transcription for a set of assets. Each asset is
 * validated (must exist + have a filePath) then enqueued; the transcripter's own
 * queue handles concurrency, so this simply fans out enqueueSpanish calls (mirrors
 * the bulk English re-transcribe). Returns which assetIds were queued vs skipped.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const body = (await req.json().catch(() => ({}))) as { assetIds?: unknown };
    const assetIds = Array.isArray(body.assetIds)
      ? body.assetIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (assetIds.length === 0) {
      return NextResponse.json({ error: 'assetIds required' }, { status: 400 });
    }

    const transcripter = getTranscripterService();
    const queued: string[] = [];
    const skipped: Array<{ assetId: string; reason: string }> = [];

    for (const assetId of assetIds) {
      const asset = getAsset(projectId, assetId);
      if (!asset) {
        skipped.push({ assetId, reason: 'not found' });
        continue;
      }
      if (!asset.filePath) {
        skipped.push({ assetId, reason: 'no file path' });
        continue;
      }
      const durationSec = typeof asset.duration === 'number' && asset.duration > 0 ? asset.duration : undefined;
      const job = transcripter.enqueueSpanish(projectId, asset.filePath, assetId, {
        durationSec,
        // Friendly name for the pipeline tray + transcripts list; without it the job
        // falls back to the UUID-style stored filename (basename of filePath).
        displayName: asset.originalFilename ?? asset.name,
      });
      patchAsset(projectId, assetId, {
        transcriptionEs: { status: 'queued', jobId: job.jobId, completedAt: null },
      });
      queued.push(assetId);
    }

    return NextResponse.json({ ok: true, queued, skipped });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
