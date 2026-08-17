import { NextRequest, NextResponse } from 'next/server';
import { getAsset } from '@/lib/store/media-registry';
import {
  clearEnglishDrift,
  saveTranscriptCues,
  TranscriptConflictError,
  TranscriptNotFoundError,
  type CueEdit,
} from '@/lib/transcripts/edit-store';
import { loadTranscriptEditorPayload } from '@/lib/transcripts/editor-payload';
import { describeSkip, republishCaptions } from '@/lib/services/caption-republish';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

/** Read both language transcripts for the editor, plus drift flags. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, assetId } = await params;
    const payload = loadTranscriptEditorPayload(projectId, assetId);
    if (!payload) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    if (!payload.en && !payload.es) {
      return NextResponse.json({ error: 'This asset has no completed transcript to edit' }, { status: 404 });
    }
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

interface SaveBody {
  lang?: 'en' | 'es';
  edits?: CueEdit[];
  baseRevision?: number;
}

/**
 * Save text-only cue edits, then replace that language's Cloudflare caption
 * track. The push is awaited (not fire-and-forget) so the editor can report a
 * real outcome — see lib/services/caption-republish.ts.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, assetId } = await params;
    const body = await req.json() as SaveBody;

    const lang = body.lang === 'es' ? 'es' : 'en';
    const edits = Array.isArray(body.edits) ? body.edits : [];
    if (edits.length === 0) return NextResponse.json({ error: 'No edits supplied' }, { status: 400 });
    if (edits.some((e) => typeof e?.text !== 'string')) {
      return NextResponse.json({ error: 'Every edit needs a text value' }, { status: 400 });
    }

    const asset = getAsset(projectId, assetId);
    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

    const info = lang === 'es' ? asset.transcriptionEs : asset.transcription;
    const jobId = info?.status === 'done' ? info.jobId : null;
    if (!jobId) return NextResponse.json({ error: `No completed ${lang} transcript for this asset` }, { status: 404 });

    const saved = saveTranscriptCues(projectId, jobId, edits, body.baseRevision ?? 0);

    // A hand-edited Spanish row counts as the drift being addressed — re-baseline
    // just those rows so the flag clears without touching the others.
    if (lang === 'es' && saved.changedIndices.length > 0 && asset.transcription?.jobId) {
      clearEnglishDrift(projectId, jobId, asset.transcription.jobId, saved.changedIndices);
    }

    const push = saved.changedIndices.length > 0
      ? await republishCaptions(projectId, assetId, jobId, lang)
      : { status: 'skipped' as const, reason: 'no_changes' as const };

    return NextResponse.json({
      lang,
      revision: saved.revision,
      changedIndices: saved.changedIndices,
      cues: saved.cues,
      cloudflare: push,
      cloudflareMessage: push.status === 'skipped' ? describeSkip(push.reason) : null,
      englishChangedIndices: loadTranscriptEditorPayload(projectId, assetId)?.englishChangedIndices ?? [],
    });
  } catch (err) {
    if (err instanceof TranscriptConflictError) {
      return NextResponse.json(
        { error: err.message, currentRevision: err.currentRevision },
        { status: 409 },
      );
    }
    if (err instanceof TranscriptNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
