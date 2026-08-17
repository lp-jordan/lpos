import { getAsset } from '@/lib/store/media-registry';
import { computeEnglishDrift, readTranscriptDoc, type TranscriptDoc } from './edit-store';

/**
 * The transcript editor's read model, shared by the server page (first paint)
 * and the GET route (refetch) so both can never drift apart.
 */
export interface TranscriptEditorPayload {
  assetId: string;
  assetName: string;
  duration: number | null;
  cloudflare: { uid: string | null; status: string | null };
  en: (TranscriptDoc & { jobId: string }) | null;
  es: (TranscriptDoc & { jobId: string }) | null;
  /** Spanish cue indices whose English source has changed since translation. */
  englishChangedIndices: number[];
}

export function loadTranscriptEditorPayload(projectId: string, assetId: string): TranscriptEditorPayload | null {
  const asset = getAsset(projectId, assetId);
  if (!asset) return null;

  const enJobId = asset.transcription?.status === 'done' ? asset.transcription.jobId : null;
  const esJobId = asset.transcriptionEs?.status === 'done' ? asset.transcriptionEs.jobId : null;

  const read = (jobId: string | null) => {
    if (!jobId) return null;
    try { return { ...readTranscriptDoc(projectId, jobId), jobId }; } catch { return null; }
  };

  const en = read(enJobId);
  const es = read(esJobId);

  return {
    assetId,
    assetName: asset.originalFilename ?? asset.name,
    duration: asset.duration,
    cloudflare: { uid: asset.cloudflare?.uid ?? null, status: asset.cloudflare?.status ?? null },
    en,
    es,
    englishChangedIndices: es && enJobId ? computeEnglishDrift(projectId, es.jobId, enJobId) : [],
  };
}
