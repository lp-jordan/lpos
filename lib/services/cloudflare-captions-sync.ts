import fs from 'node:fs';
import { getAsset } from '@/lib/store/media-registry';
import { getTranscriptPaths } from '@/lib/transcripts/store';
import { isCloudflareStreamConfigured, uploadCaptionsVtt } from '@/lib/services/cloudflare-stream';

/**
 * Called after a transcription job completes.
 * If the asset's Cloudflare video is already ready, pushes the new VTT as a caption
 * track in the given language (default 'en'). Cloudflare stores one track per
 * language code, so an 'es' push adds a Spanish track alongside the English one.
 * If the asset has no ready Cloudflare video, this is a no-op — captions attach
 * later when the asset is published to Cloudflare (see the publish flows).
 * Errors are swallowed — this is a best-effort background operation.
 */
export async function uploadCaptionsToCloudflare(
  projectId: string,
  assetId: string,
  jobId: string,
  language = 'en',
): Promise<void> {
  if (!isCloudflareStreamConfigured()) return;

  const asset = getAsset(projectId, assetId);
  if (!asset) return;

  const cfUid = asset.cloudflare?.uid;
  const cfStatus = asset.cloudflare?.status;
  if (!cfUid || cfStatus !== 'ready') return;

  const { vttPath } = getTranscriptPaths(projectId, jobId);
  if (!fs.existsSync(vttPath)) {
    console.warn(`[cf-captions] VTT not found at ${vttPath}; skipping ${language} captions upload for uid=${cfUid}`);
    return;
  }

  try {
    await uploadCaptionsVtt(cfUid, vttPath, language);
    console.log(`[cf-captions] ${language} captions uploaded for uid=${cfUid} (assetId=${assetId}, jobId=${jobId})`);
  } catch (err) {
    console.warn(`[cf-captions] failed to upload ${language} captions for uid=${cfUid}:`, err);
  }
}
