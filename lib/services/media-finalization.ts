/**
 * media-finalization.ts
 *
 * Shared post-upload finalization logic used by both the legacy single-shot
 * upload route and the chunked upload endpoints.
 *
 * Handles: version/duplicate detection, asset registration, stable rename,
 * activity recording, and background jobs (duration probe, transcription,
 * Frame.io upload).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ActivityActor } from '@/lib/models/activity';
import type { MediaAsset } from '@/lib/models/media-asset';
import type { Project } from '@/lib/models/project';
import { registerAsset, patchAsset, getAsset } from '@/lib/store/media-registry';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import { triggerFrameIOUpload } from '@/lib/services/frameio-upload';
import { findCanonicalVersionCandidate } from '@/lib/store/canonical-asset-store';
import { probeDuration } from '@/lib/services/media-probe';
import { getTranscripterService, getIngestQueueService } from '@/lib/services/container';

function getIngestQueue() {
  try { return getIngestQueueService(); } catch { return null; }
}

export interface FinalizeInput {
  projectId:       string;
  project:         Project;
  filename:        string;
  tempPath:        string;
  mediaDir:        string;
  preComputedHash: string;          // 'sha256:...'
  replaceAssetId?: string;
  jobId?:          string;
  actor:           ActivityActor;
}

export type FinalizeResult =
  | { outcome: 'duplicate';                     asset: MediaAsset }
  | { outcome: 'version_confirmation_required'; existingAsset: MediaAsset; currentVersionNumber: number }
  | { outcome: 'registered';                    asset: MediaAsset; stableDest: string };

export async function finalizeUploadedAsset(input: FinalizeInput): Promise<FinalizeResult> {
  const {
    projectId, project, filename, tempPath, mediaDir,
    preComputedHash, replaceAssetId, jobId, actor,
  } = input;

  const ingestQueue = getIngestQueue();
  const ext = path.extname(filename).toLowerCase();

  // ── Version / duplicate detection ──────────────────────────────────────────
  if (!replaceAssetId) {
    const versionCandidate = findCanonicalVersionCandidate(
      projectId, filename, tempPath, preComputedHash,
    );

    if (versionCandidate?.duplicate) {
      return { outcome: 'duplicate', asset: versionCandidate.asset };
    }

    if (versionCandidate) {
      return {
        outcome: 'version_confirmation_required',
        existingAsset: versionCandidate.asset,
        currentVersionNumber: versionCandidate.currentVersionNumber,
      };
    }
  }

  // ── Capture prior Frame.io IDs before registering the new version ───────────
  // Once registerAsset runs, the new version becomes current and the prior
  // version's distribution record is no longer returned by getAsset.
  let priorFrameioFileId: string | null = null;
  let priorFrameioStackId: string | null = null;
  if (replaceAssetId) {
    const priorAsset = getAsset(projectId, replaceAssetId);
    priorFrameioFileId  = priorAsset?.frameio.assetId ?? null;
    priorFrameioStackId = priorAsset?.frameio.stackId ?? null;
  }

  // ── Register asset ──────────────────────────────────────────────────────────
  const stat = await fs.promises.stat(tempPath);
  const asset = registerAsset({
    projectId,
    originalFilename: filename,
    filePath: tempPath,
    fileSize: stat.size,
    storageType: 'uploaded',
    existingAssetId: replaceAssetId,
    preComputedHash,
  });

  // ── Rename temp → stable ────────────────────────────────────────────────────
  const stableDest = path.join(mediaDir, `${asset.assetId}${ext}`);
  await fs.promises.rename(tempPath, stableDest);

  if (jobId) {
    ingestQueue?.setStablePath(jobId, stableDest);
    ingestQueue?.setAssetId(jobId, asset.assetId);
  }
  patchAsset(projectId, asset.assetId, { filePath: stableDest });

  recordActivity({
    ...actor,
    occurred_at: new Date().toISOString(),
    event_type: 'asset.registered',
    lifecycle_phase: 'created',
    source_kind: 'api',
    visibility: 'user_timeline',
    title: `Asset uploaded: ${asset.name || asset.originalFilename}`,
    summary: `${asset.originalFilename} was uploaded to ${project.name}`,
    client_id: project.clientName || null,
    project_id: projectId,
    asset_id: asset.assetId,
    details_json: {
      originalFilename: asset.originalFilename,
      filePath: stableDest,
      storageType: asset.storageType,
    },
    search_text: `${asset.originalFilename} ${project.name} ${project.clientName}`.trim(),
  });

  // ── Background jobs (non-blocking) ─────────────────────────────────────────
  probeDuration(stableDest).then((dur) => {
    if (dur != null) patchAsset(projectId, asset.assetId, { duration: dur });
  }).catch(() => {});

  if (jobId) ingestQueue?.complete(jobId);

  // Skip auto-transcription for new versions — the existing transcript remains
  // current until the operator manually retranscribes.
  if (!replaceAssetId) {
    try {
      const job = getTranscripterService().enqueue(
        projectId, stableDest, asset.assetId, asset.originalFilename,
      );
      patchAsset(projectId, asset.assetId, {
        transcription: { status: 'queued', jobId: job.jobId, completedAt: null },
      });
    } catch (err) {
      console.error('[media-finalization] failed to enqueue transcription:', err);
    }
  }

  triggerFrameIOUpload(projectId, asset.assetId, {
    actor,
    clientId: project.clientName || null,
    priorFrameioFileId,
    priorFrameioStackId,
  });

  return { outcome: 'registered', asset, stableDest };
}

/**
 * Stream-hash a file on disk to produce a 'sha256:...' content hash string.
 * Used at chunked upload finalization time when no in-stream hash was computed.
 */
export async function hashFile(filePath: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return `sha256:${hash.digest('hex')}`;
}
