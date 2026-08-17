import { NextRequest, NextResponse } from 'next/server';
import { getAsset } from '@/lib/store/media-registry';
import {
  clearEnglishDrift,
  computeEnglishDrift,
  readTranscriptDoc,
  saveTranscriptCues,
} from '@/lib/transcripts/edit-store';
import { translateCueTexts } from '@/lib/services/transcript-translation';
import { describeSkip, republishCaptions } from '@/lib/services/caption-republish';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

/**
 * Re-translate ONLY the Spanish cues whose English source has drifted.
 *
 * Scoped on purpose: a whole-file retranslation would overwrite Spanish rows a
 * person had corrected by hand. Because the two transcripts are index-aligned,
 * refreshing a subset is exact — cue N's Spanish is replaced from cue N's
 * English and nothing else moves.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, assetId } = await params;
    const body = await req.json().catch(() => ({})) as { indices?: number[] };

    const asset = getAsset(projectId, assetId);
    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

    const enJobId = asset.transcription?.status === 'done' ? asset.transcription.jobId : null;
    const esJobId = asset.transcriptionEs?.status === 'done' ? asset.transcriptionEs.jobId : null;
    if (!enJobId || !esJobId) {
      return NextResponse.json({ error: 'This asset needs both an English and a Spanish transcript' }, { status: 404 });
    }

    const drifted = computeEnglishDrift(projectId, esJobId, enJobId);
    const requested = Array.isArray(body.indices) && body.indices.length > 0
      ? body.indices.filter((i) => drifted.includes(i))
      : drifted;

    if (requested.length === 0) {
      return NextResponse.json({ error: 'No Spanish rows are out of date' }, { status: 400 });
    }

    const english = readTranscriptDoc(projectId, enJobId);
    const spanish = readTranscriptDoc(projectId, esJobId);

    const sourceTexts = requested.map((index) => english.cues[index]?.text ?? '');
    const translated = await translateCueTexts(sourceTexts, { projectId, assetId, jobId: esJobId });

    const saved = saveTranscriptCues(
      projectId,
      esJobId,
      requested.map((index, i) => ({ index, text: translated[i] })),
      spanish.revision,
    );

    clearEnglishDrift(projectId, esJobId, enJobId, requested);

    const push = saved.changedIndices.length > 0
      ? await republishCaptions(projectId, assetId, esJobId, 'es')
      : { status: 'skipped' as const, reason: 'no_changes' as const };

    return NextResponse.json({
      revision: saved.revision,
      retranslatedIndices: requested,
      cues: saved.cues,
      cloudflare: push,
      cloudflareMessage: push.status === 'skipped' ? describeSkip(push.reason) : null,
      englishChangedIndices: computeEnglishDrift(projectId, esJobId, enJobId),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
