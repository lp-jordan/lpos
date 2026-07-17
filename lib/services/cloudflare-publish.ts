import fs from 'node:fs';
import type { ActivityActor } from '@/lib/models/activity';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { getLatestDistributionInfoForAsset, listCloudflareUidsForAsset } from '@/lib/store/canonical-asset-store';
import { recordOrphan, markOrphanPurged } from '@/lib/store/cloudflare-orphan-store';
import { getUploadQueueService } from '@/lib/services/container';
import { probeMediaInfo } from '@/lib/services/media-probe';
import { getTranscriptPaths } from '@/lib/transcripts/store';
import {
  applyVideoSettings,
  createCloudflareTusUpload,
  deleteCloudflareVideo,
  getCloudflareStreamConfigDiagnostic,
  getCloudflareFileSize,
  getCloudflareVideoState,
  isCloudflareStreamConfigured,
  listCloudflareVideos,
  uploadCaptionsVtt,
  uploadFileToCloudflareTus,
  waitForCloudflareVideoReady,
} from '@/lib/services/cloudflare-stream';

/**
 * Cloudflare Stream upload — decoupled from LeaderPass publish.
 *
 * This is the lean, Cloudflare-only upload path used to make CF the primary
 * internal playback layer (sidebar/theater player + scrub thumbnails). It
 * orchestrates the same low-level cloudflare-stream.ts primitives as
 * leaderpass-publish.ts, but does NOT touch `asset.leaderpass.*`, build the
 * LeaderPass `pendingPayload`/`awaiting_platform` handoff, or hardcode the
 * leaderpass playback origin. `allowedOrigins` is caller-supplied.
 *
 * Phase 0 of the CF auto-upload build (see the project_cloudflare_auto_upload
 * memory). It is intentionally standalone so the live manual "Push to
 * Cloudflare" flow (leaderpass-publish.ts) stays byte-identical; the temporary
 * orchestration overlap between the two is reconciled in a later cleanup once
 * auto-upload is proven.
 *
 * NOTE: signed URLs are deliberately NOT enabled here. The interim security
 * model is `allowedOrigins` only (LPOS host + downstream platform domain);
 * `requireSignedURLs` waits on the LeaderPass UID-based tether, because turning
 * it on would 403 LPOS's own raw-HLS player + thumbnails until token minting
 * exists on both sides.
 *
 * Follow-ups deferred from Phase 0 (wired in Phase 1+): UploadTray queue job +
 * cancellation, activity-timeline events, and the manual-push concurrency guard
 * widening (leaderpass-publish only skips on cloudflare.status==='processing',
 * not 'uploading').
 */

const CLOUDFLARE_DEFAULT_THUMBNAIL_FRAME = 24;

/** Upload-queue accessor — the pipeline tracker surfaces our job as a stage. */
function getQueue() {
  try {
    return getUploadQueueService();
  } catch {
    return null;
  }
}

// Orchestration-level retry. The low-level cloudflare-stream fetches already
// retry transient 5xx/409 per-chunk; this is the outer safety net for a whole-
// upload failure (e.g. the create-upload call, or a ready-poll timeout). In-
// memory (per assetId) — a process restart resets it, which is fine.
const MAX_CF_RETRIES   = 2;
const CF_RETRY_DELAY_MS = 30_000;
const cfRetryAttempts  = new Map<string, number>();

/** Pull the custom poster URL out of a prior CF distribution's metadata_json, if any. */
function readPriorPosterUrl(prior: { metadata_json: string | null } | null): string | null {
  if (!prior?.metadata_json) return null;
  try {
    const meta = JSON.parse(prior.metadata_json) as { posterUrl?: unknown };
    return typeof meta.posterUrl === 'string' && meta.posterUrl ? meta.posterUrl : null;
  } catch {
    return null;
  }
}

export interface CloudflareUploadOptions {
  /**
   * Origins permitted to play this video (LPOS host + any downstream platform
   * domain). Omit or pass an empty array to leave the video unrestricted.
   */
  allowedOrigins?: string[] | null;
  /** Reserved for activity-timeline attribution once events are wired. */
  actor?: ActivityActor;
}

export function canUploadToCloudflare(): boolean {
  return isCloudflareStreamConfigured();
}

/** Fire-and-forget background Cloudflare upload. */
export function triggerCloudflareUpload(
  projectId: string,
  assetId: string,
  options?: CloudflareUploadOptions,
): void {
  setImmediate(() => {
    void runCloudflareUpload(projectId, assetId, options).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[cloudflare-publish] unhandled upload failure for asset ${assetId}: ${message}`);
      patchAsset(projectId, assetId, {
        cloudflare: { status: 'failed', progress: 0, lastError: message },
      });
    });
  });
}

export async function runCloudflareUpload(
  projectId: string,
  assetId: string,
  options?: CloudflareUploadOptions,
): Promise<void> {
  const asset = getAsset(projectId, assetId);
  if (!asset || !asset.filePath) {
    console.warn(`[cloudflare-publish] skipped upload for asset ${assetId}: asset or file path missing`);
    return;
  }

  // Verify the file is actually accessible before touching Cloudflare at all.
  // A missing file almost always means an external drive isn't mounted.
  if (!fs.existsSync(asset.filePath)) {
    const hint = asset.filePath.startsWith('/Volumes/')
      ? `File not found — the drive at ${asset.filePath.split('/').slice(0, 3).join('/')} may not be mounted.`
      : `File not found at: ${asset.filePath}`;
    console.error(`[cloudflare-publish] aborting upload for asset ${assetId}: ${hint}`);
    patchAsset(projectId, assetId, {
      cloudflare: { status: 'failed', progress: 0, lastError: hint },
    });
    return;
  }

  if (!canUploadToCloudflare()) {
    const diagnostic = getCloudflareStreamConfigDiagnostic();
    console.error(`[cloudflare-publish] config invalid for asset ${assetId}: ${diagnostic.message ?? 'unknown config error'}`);
    patchAsset(projectId, assetId, {
      cloudflare: {
        status: 'failed',
        lastError: diagnostic.message ?? 'Cloudflare Stream is not configured on this LPOS host.',
      },
    });
    return;
  }

  // Don't collide with an in-flight upload — our own, or a manual LeaderPass
  // publish that is mid-preparation (it drives the same CF video).
  if (
    asset.cloudflare.status === 'uploading' ||
    asset.cloudflare.status === 'processing' ||
    asset.leaderpass.status === 'preparing'
  ) {
    console.warn(`[cloudflare-publish] asset ${assetId} already has a CF upload in progress; skipping duplicate trigger`);
    return;
  }

  console.log(`[cloudflare-publish] starting upload for asset ${assetId} (${asset.originalFilename})`);

  // Capture the prior CF distribution BEFORE the 'uploading' patch creates a new
  // record. Otherwise getLatestDistributionInfoForAsset returns the just-made
  // (uid-null) uploading record and the old uid is never deleted on a version
  // replace. We also carry the custom poster forward (it lives in the prior
  // record's metadata_json and a new version starts a fresh record without it).
  const priorCloudflare = getLatestDistributionInfoForAsset(assetId, 'cloudflare');
  const priorPosterUrl  = readPriorPosterUrl(priorCloudflare);

  // Register a queue job so this upload shows as a "Cloudflare" stage in the
  // pipeline (the tracker is queue-job-driven, not status-driven).
  const queue    = getQueue();
  const filename = asset.name || asset.originalFilename;
  const jobId    = queue?.add(projectId, assetId, filename, 'cloudflare') ?? null;
  const cancelled = () => (jobId ? queue?.isCancelled(jobId) ?? false : false);

  patchAsset(projectId, assetId, {
    cloudflare: { status: 'uploading', progress: 0, lastError: null, readyAt: null },
  });

  // Hoisted so the catch block can tear down a half-uploaded CF video on cancel.
  let prepared: { uid: string; uploadUrl: string } | null = null;
  try {
    prepared = await createCloudflareTusUpload(asset);
    console.log(`[cloudflare-publish] upload initialized for asset ${assetId}; uid=${prepared.uid}`);

    patchAsset(projectId, assetId, {
      cloudflare: { uid: prepared.uid, uploadUrl: prepared.uploadUrl, creator: asset.assetId },
    });

    // Lock allowed origins immediately — before any bytes are transferred.
    const allowedOrigins = options?.allowedOrigins ?? null;
    if (allowedOrigins && allowedOrigins.length > 0) {
      try {
        await applyVideoSettings(prepared.uid, { allowedOrigins });
        console.log(`[cloudflare-publish] allowedOrigins set for uid=${prepared.uid}`);
      } catch (err) {
        console.warn(`[cloudflare-publish] failed to set allowedOrigins for uid=${prepared.uid}:`, err);
      }
    }

    await uploadFileToCloudflareTus(prepared.uploadUrl, asset.filePath, {
      onProgress: (progress) => {
        if (jobId) queue?.setProgress(jobId, progress);
        patchAsset(projectId, assetId, { cloudflare: { progress } });
      },
      isCancelled: jobId ? cancelled : undefined,
    });

    console.log(`[cloudflare-publish] upload complete for asset ${assetId}; waiting for Cloudflare processing`);
    patchAsset(projectId, assetId, {
      cloudflare: { status: 'processing', progress: 100, uploadedAt: new Date().toISOString() },
    });
    if (jobId) queue?.setProcessing(jobId, 'Waiting for Cloudflare Stream processing');

    // Heartbeat the queue job during the encode wait so the stale-job sweep
    // doesn't auto-fail us while Cloudflare is legitimately processing.
    const heartbeat = jobId ? setInterval(() => queue?.heartbeat(jobId), 60_000) : null;
    let ready;
    try {
      ready = await waitForCloudflareVideoReady(prepared.uid, { isCancelled: jobId ? cancelled : undefined });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    console.log(`[cloudflare-publish] Cloudflare asset ready for ${assetId}; uid=${ready.uid}`);

    // Default thumbnail frame — probe fps fresh since it may not have been
    // stored at ingest. A custom poster (cloudflare.posterUrl, a Cloudflare
    // Images URL) is uid-independent and preserved automatically by the partial
    // patches below, so we never clobber it here.
    try {
      const targetFrame = CLOUDFLARE_DEFAULT_THUMBNAIL_FRAME;
      const { fps, duration } = await probeMediaInfo(asset.filePath);
      const effectiveDuration = asset.duration ?? duration;
      const pct = (fps != null && fps > 0 && effectiveDuration != null && effectiveDuration > 0)
        ? Math.max(0.001, Math.min(0.999, targetFrame / (fps * effectiveDuration)))
        : null;
      if (pct !== null) {
        await applyVideoSettings(prepared.uid, { thumbnailTimestampPct: pct });
        console.log(`[cloudflare-publish] thumbnailTimestampPct=${pct.toFixed(4)} (frame ${targetFrame}) set for uid=${prepared.uid}`);
      } else {
        console.warn(`[cloudflare-publish] could not compute thumbnailTimestampPct for uid=${prepared.uid} (fps=${fps}, duration=${effectiveDuration})`);
      }
    } catch (err) {
      console.warn(`[cloudflare-publish] failed to set thumbnailTimestampPct for uid=${prepared.uid}:`, err);
    }

    // Upload VTT captions if a completed transcript exists for this asset.
    if (asset.transcription.status === 'done' && asset.transcription.jobId) {
      try {
        const { vttPath } = getTranscriptPaths(projectId, asset.transcription.jobId);
        if (fs.existsSync(vttPath)) {
          await uploadCaptionsVtt(ready.uid, vttPath);
          console.log(`[cloudflare-publish] captions uploaded for uid=${ready.uid} (jobId=${asset.transcription.jobId})`);
        } else {
          console.warn(`[cloudflare-publish] VTT not found at ${vttPath}; skipping captions for uid=${ready.uid}`);
        }
      } catch (err) {
        console.warn(`[cloudflare-publish] failed to upload captions for uid=${ready.uid}:`, err);
      }
    }

    // Also attach the Spanish track if a completed Spanish transcript exists, so
    // uploading an asset that was Spanish-transcribed BEFORE it reached Cloudflare
    // still gets its 'es' captions (order-independent with the on-completion push).
    if (asset.transcriptionEs?.status === 'done' && asset.transcriptionEs.jobId) {
      try {
        const { vttPath } = getTranscriptPaths(projectId, asset.transcriptionEs.jobId);
        if (fs.existsSync(vttPath)) {
          await uploadCaptionsVtt(ready.uid, vttPath, 'es');
          console.log(`[cloudflare-publish] es captions uploaded for uid=${ready.uid} (jobId=${asset.transcriptionEs.jobId})`);
        } else {
          console.warn(`[cloudflare-publish] es VTT not found at ${vttPath}; skipping es captions for uid=${ready.uid}`);
        }
      } catch (err) {
        console.warn(`[cloudflare-publish] failed to upload es captions for uid=${ready.uid}:`, err);
      }
    }

    const readyAt = ready.readyAt ?? new Date().toISOString();
    patchAsset(projectId, assetId, {
      cloudflare: {
        uid: ready.uid,
        previewUrl: ready.previewUrl,
        thumbnailUrl: ready.thumbnailUrl,
        hlsUrl: ready.hlsUrl,
        dashUrl: ready.dashUrl,
        status: 'ready',
        progress: 100,
        readyAt,
        lastError: null,
        // Carry the custom poster forward to this version's fresh record so a
        // version replace doesn't silently drop the user's chosen thumbnail.
        // (posterUrl is a uid-independent Cloudflare Images URL.)
        ...(priorPosterUrl ? { posterUrl: priorPosterUrl } : {}),
      },
    });

    // Delete the prior Cloudflare video now that the new one is confirmed ready.
    // One retry on failure, then surface the orphan to the cloudflare_orphans
    // table for manual purge. Never block the flow on this.
    const oldCloudflareUid = priorCloudflare?.provider_asset_id ?? null;
    if (oldCloudflareUid && oldCloudflareUid !== ready.uid) {
      let lastErr: string | null = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await deleteCloudflareVideo(oldCloudflareUid);
          console.log(`[cloudflare-publish] deleted prior Cloudflare video uid=${oldCloudflareUid} for asset ${assetId} (attempt ${attempt})`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          console.warn(`[cloudflare-publish] failed to delete prior Cloudflare video uid=${oldCloudflareUid} (attempt ${attempt}):`, lastErr);
        }
      }
      if (lastErr) {
        try {
          recordOrphan({
            uid: oldCloudflareUid,
            assetId,
            projectId,
            reason: 'delete_failed',
            attempts: 2,
            lastError: lastErr,
          });
          console.warn(`[cloudflare-publish] recorded uid=${oldCloudflareUid} as Cloudflare orphan for manual purge`);
        } catch (recordErr) {
          console.error(`[cloudflare-publish] failed to record orphan uid=${oldCloudflareUid}:`, recordErr);
        }
      }
    }

    if (jobId) queue?.complete(jobId);
    cfRetryAttempts.delete(assetId);
    console.log(`[cloudflare-publish] asset ${assetId} uploaded to Cloudflare and ready`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wasCancelled = message === 'Cancelled';
    console.error(`[cloudflare-publish] upload ${wasCancelled ? 'cancelled' : 'failed'} for asset ${assetId}: ${message}`);

    // On cancel, delete the half-uploaded CF video so it doesn't linger as an
    // orphan, and clear the dead uid so a re-trigger starts fresh.
    if (wasCancelled && prepared?.uid) {
      try {
        await deleteCloudflareVideo(prepared.uid);
        console.log(`[cloudflare-publish] deleted cancelled Cloudflare video uid=${prepared.uid} for asset ${assetId}`);
      } catch (err) {
        const e = err instanceof Error ? err.message : String(err);
        try {
          recordOrphan({ uid: prepared.uid, assetId, projectId, name: filename, reason: 'delete_failed', attempts: 1, lastError: `cancel: ${e}` });
        } catch { /* best effort */ }
      }
    }

    patchAsset(projectId, assetId, {
      cloudflare: {
        status: wasCancelled ? 'none' : 'failed',
        progress: 0,
        lastError: wasCancelled ? null : message,
        ...(wasCancelled ? { uid: null, uploadUrl: null } : {}),
      },
    });

    if (jobId) {
      if (wasCancelled) queue?.cancel(jobId);
      else queue?.fail(jobId, message);
    }

    // Transient-failure retry: re-trigger after a backoff, capped. A deliberate
    // cancel is never retried. The retry re-enters with a clean guard (status is
    // now 'failed'), and its prior-uid delete cleans up this failed attempt's
    // partial CF video.
    if (!wasCancelled) {
      const attempts = cfRetryAttempts.get(assetId) ?? 0;
      if (attempts < MAX_CF_RETRIES) {
        cfRetryAttempts.set(assetId, attempts + 1);
        console.warn(`[cloudflare-publish] transient failure for ${assetId}; retry ${attempts + 1}/${MAX_CF_RETRIES} in ${CF_RETRY_DELAY_MS / 1000}s`);
        setTimeout(() => triggerCloudflareUpload(projectId, assetId, options), CF_RETRY_DELAY_MS);
      } else {
        cfRetryAttempts.delete(assetId);
        console.error(`[cloudflare-publish] giving up on ${assetId} after ${MAX_CF_RETRIES} retries`);
      }
    }
  }
}

export interface CloudflarePruneResult {
  /** UID kept as the single live survivor (null when none could be confirmed live). */
  keptUid: string | null;
  /** UIDs successfully deleted from Cloudflare. */
  deletedUids: string[];
  /** UIDs whose delete failed — recorded as cloudflare_orphans for the 24h reconciler to retry. */
  failedUids: Array<{ uid: string; error: string }>;
  /** How many CF videos still existed for the asset before pruning. */
  candidateCount: number;
  /**
   * True when no confirmed-live (readyToStream=true) video existed, so nothing
   * was deleted — the safety rail that refuses to leave the asset with zero
   * playable video just to satisfy a cleanup.
   */
  skipped: boolean;
  reason?: string;
}

/**
 * Forcefully collapse an asset's Cloudflare footprint to a single live video.
 *
 * Enumerates EVERY Cloudflare Stream video belonging to this asset — via the
 * `creator` tag (the assetId, stamped on every upload as Upload-Creator),
 * unioned with the UIDs recorded in distribution_records and any caller-supplied
 * `preferUid` — then:
 *   1. Probes each candidate's live status directly in Cloudflare (readyToStream).
 *   2. Keeps the most-recently-created LIVE video (preferring `preferUid` if it
 *      is itself live).
 *   3. Deletes every OTHER candidate from Cloudflare.
 *
 * Safety rail: if NO candidate is confirmed live, it deletes nothing and returns
 * `skipped: true`. We never leave the asset with zero playable video. Listing
 * Cloudflare failing is also treated as skip-and-keep.
 *
 * This only touches Cloudflare (+ the orphan bookkeeping table). It does not
 * rewrite distribution_records; the caller repoints LPOS's local pointer at the
 * survivor.
 */
export async function pruneCloudflareVersionsForAsset(
  assetId: string,
  opts?: { preferUid?: string | null },
): Promise<CloudflarePruneResult> {
  const empty = (skipped: boolean, reason: string, candidateCount = 0): CloudflarePruneResult => ({
    keptUid: null, deletedUids: [], failedUids: [], candidateCount, skipped, reason,
  });

  const creatorKey = assetId.slice(0, 64); // matches Upload-Creator set on upload

  // 1. Enumerate candidate UIDs from all sources. The `creator` list is the
  //    authoritative one (it finds videos LPOS has lost the DB link to); the
  //    distribution_records + preferUid unions are belt-and-suspenders.
  const candidateUids = new Set<string>();
  const createdByUid = new Map<string, string | null>();
  try {
    const cfList = await listCloudflareVideos();
    for (const v of cfList) {
      createdByUid.set(v.uid, v.created);
      if (v.creator && v.creator === creatorKey) candidateUids.add(v.uid);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return empty(true, `Could not list Cloudflare videos: ${message}`);
  }
  for (const uid of listCloudflareUidsForAsset(assetId)) candidateUids.add(uid);
  if (opts?.preferUid) candidateUids.add(opts.preferUid);

  if (candidateUids.size === 0) return empty(true, 'No Cloudflare videos found for this asset.');

  // 2. Probe live status per candidate. A 404 means it's already gone (drop it);
  //    any other probe error is treated conservatively as "still exists, not live"
  //    so we neither delete it nor let it be the survivor.
  interface Candidate { uid: string; live: boolean; created: string | null; exists: boolean; }
  const candidates: Candidate[] = [];
  for (const uid of candidateUids) {
    try {
      const state = await getCloudflareVideoState(uid);
      candidates.push({ uid, live: state.status === 'ready', created: state.uploadedAt ?? createdByUid.get(uid) ?? null, exists: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const gone = /\b404\b/.test(message) || /not[_\s-]?found/i.test(message);
      candidates.push({ uid, live: false, created: createdByUid.get(uid) ?? null, exists: !gone });
    }
  }

  const existing = candidates.filter((c) => c.exists);
  const liveOnes = existing.filter((c) => c.live);

  // 3. Safety rail — no confirmed-live survivor → delete nothing.
  if (liveOnes.length === 0) {
    return empty(true, 'No Cloudflare video for this asset is confirmed live (readyToStream); refusing to delete duplicates.', existing.length);
  }

  // Survivor = the preferred UID if it is itself live, else the newest live video.
  const byNewest = (a: Candidate, b: Candidate) => (b.created ?? '').localeCompare(a.created ?? '');
  const preferredLive = opts?.preferUid ? liveOnes.find((c) => c.uid === opts.preferUid) : undefined;
  const keptUid = (preferredLive ?? [...liveOnes].sort(byNewest)[0]).uid;

  // 4. Delete every other still-existing candidate.
  const deletedUids: string[] = [];
  const failedUids: Array<{ uid: string; error: string }> = [];
  for (const c of existing) {
    if (c.uid === keptUid) continue;
    try {
      await deleteCloudflareVideo(c.uid);
      deletedUids.push(c.uid);
      try { markOrphanPurged(c.uid); } catch { /* best effort */ }
      console.log(`[cloudflare-prune] deleted stale CF video uid=${c.uid} for asset ${assetId} (kept ${keptUid})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedUids.push({ uid: c.uid, error: message });
      try { recordOrphan({ uid: c.uid, assetId, reason: 'delete_failed', attempts: 1, lastError: message }); } catch { /* best effort */ }
      console.warn(`[cloudflare-prune] failed to delete stale CF video uid=${c.uid} for asset ${assetId}:`, message);
    }
  }

  return { keptUid, deletedUids, failedUids, candidateCount: existing.length, skipped: false };
}
