import crypto from 'node:crypto';
import fs from 'node:fs';
import { getAsset } from '@/lib/store/media-registry';
import { getTranscriptPaths } from '@/lib/transcripts/store';
import { patchEditMeta } from '@/lib/transcripts/edit-store';
import { isCloudflareStreamConfigured, uploadCaptionsVtt } from '@/lib/services/cloudflare-stream';

/**
 * Foreground caption republish, for edits a person just made.
 *
 * Distinct from cloudflare-captions-sync.ts on purpose: that one fires after a
 * transcription job completes and is deliberately best-effort/fire-and-forget.
 * A manual edit needs the opposite — the operator must see whether the push
 * landed, so this awaits the upload and reports a typed outcome instead of
 * swallowing failures into a log line.
 *
 * Cloudflare's `PUT /stream/{uid}/captions/{language}` is an upsert, so pushing
 * replaces that language's existing track in place. Languages are independent:
 * an 'es' push never disturbs the 'en' track.
 */

export type CaptionSkipReason = 'not_configured' | 'no_video' | 'video_not_ready' | 'no_vtt' | 'no_changes';

export type CaptionPushOutcome =
  | { status: 'pushed'; syncedAt: string }
  | { status: 'skipped'; reason: CaptionSkipReason }
  | { status: 'failed'; error: string };

export async function republishCaptions(
  projectId: string,
  assetId: string,
  jobId: string,
  language: 'en' | 'es',
): Promise<CaptionPushOutcome> {
  if (!isCloudflareStreamConfigured()) return { status: 'skipped', reason: 'not_configured' };

  const asset = getAsset(projectId, assetId);
  const uid = asset?.cloudflare?.uid;
  if (!uid) return { status: 'skipped', reason: 'no_video' };
  if (asset?.cloudflare?.status !== 'ready') return { status: 'skipped', reason: 'video_not_ready' };

  const { vttPath } = getTranscriptPaths(projectId, jobId);
  if (!fs.existsSync(vttPath)) return { status: 'skipped', reason: 'no_vtt' };

  try {
    await uploadCaptionsVtt(uid, vttPath, language);
    const syncedAt = new Date().toISOString();
    const vttSha1 = crypto.createHash('sha1').update(fs.readFileSync(vttPath)).digest('hex').slice(0, 16);
    patchEditMeta(projectId, jobId, { captions: { syncedAt, vttSha1, error: null } });
    console.log(`[caption-republish] ${language} captions replaced for uid=${uid} (assetId=${assetId}, jobId=${jobId})`);
    return { status: 'pushed', syncedAt };
  } catch (err) {
    const error = (err as Error).message || 'Cloudflare rejected the caption upload';
    patchEditMeta(projectId, jobId, {
      captions: { syncedAt: null, vttSha1: null, error },
    });
    console.warn(`[caption-republish] failed to replace ${language} captions for uid=${uid}:`, err);
    return { status: 'failed', error };
  }
}

/** Human-facing explanation for a skipped push — surfaced verbatim in the editor. */
export function describeSkip(reason: CaptionSkipReason): string {
  switch (reason) {
    case 'not_configured': return 'Cloudflare Stream isn’t configured, so captions stay on disk only.';
    case 'no_video':       return 'This asset isn’t on Cloudflare yet — captions will attach when it’s published.';
    case 'video_not_ready':return 'The Cloudflare video is still processing — captions will attach when it’s ready.';
    case 'no_vtt':         return 'No subtitle file was found for this transcript.';
    case 'no_changes':     return 'Nothing changed, so the caption track was left alone.';
  }
}
