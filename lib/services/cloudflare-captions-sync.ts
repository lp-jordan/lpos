import fs from 'node:fs';
import { getAsset } from '@/lib/store/media-registry';
import { getTranscriptPaths } from '@/lib/transcripts/store';
import { isCloudflareStreamConfigured, uploadCaptionsVtt } from '@/lib/services/cloudflare-stream';

/**
 * Called after a transcription job completes.
 * If the asset's Cloudflare video is already ready, pushes the new VTT as English captions.
 * Errors are swallowed — this is a best-effort background operation.
 */
export async function uploadCaptionsToCloudflare(
  projectId: string,
  assetId: string,
  jobId: string,
): Promise<void> {
  if (!isCloudflareStreamConfigured()) return;

  const asset = getAsset(projectId, assetId);
  if (!asset) return;

  const cfUid = asset.cloudflare?.uid;
  const cfStatus = asset.cloudflare?.status;
  if (!cfUid || cfStatus !== 'ready') return;

  const { vttPath } = getTranscriptPaths(projectId, jobId);
  if (!fs.existsSync(vttPath)) {
    console.warn(`[cf-captions] VTT not found at ${vttPath}; skipping captions upload for uid=${cfUid}`);
    return;
  }

  try {
    await uploadCaptionsVtt(cfUid, vttPath);
    console.log(`[cf-captions] captions uploaded for uid=${cfUid} (assetId=${assetId}, jobId=${jobId})`);
  } catch (err) {
    console.warn(`[cf-captions] failed to upload captions for uid=${cfUid}:`, err);
  }
}
