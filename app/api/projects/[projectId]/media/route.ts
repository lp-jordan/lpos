import { NextRequest, NextResponse } from 'next/server';
import busboy from 'busboy';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectStore, getTranscripterService, getIngestQueueService } from '@/lib/services/container';
import {
  readRegistry, registerAsset, migrateLooseFiles, patchAsset, writeRegistry,
} from '@/lib/store/media-registry';
import { resolveRequestActor } from '@/lib/services/activity-actor';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import { getComments } from '@/lib/services/frameio';
import { triggerFrameIOUpload } from '@/lib/services/frameio-upload';
import type { MediaAsset } from '@/lib/models/media-asset';
import { findCanonicalVersionCandidate } from '@/lib/store/canonical-asset-store';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { probeDuration } from '@/lib/services/media-probe';

function getIngestQueue() {
  try { return getIngestQueueService(); } catch { return null; }
}

async function refreshFrameIOCommentCounts(projectId: string, assets: MediaAsset[]): Promise<MediaAsset[]> {
  const refreshed = await Promise.all(assets.map(async (asset) => {
    if (!asset.frameio.assetId) return asset;

    try {
      const commentCount = (await getComments(asset.frameio.assetId)).length;
      if (commentCount === asset.frameio.commentCount) return asset;

      return {
        ...asset,
        frameio: {
          ...asset.frameio,
          commentCount,
        },
        updatedAt: new Date().toISOString(),
      };
    } catch {
      return asset;
    }
  }));

  const changed = refreshed.some((asset, index) => asset.frameio.commentCount !== assets[index]?.frameio.commentCount);
  if (changed) writeRegistry(projectId, refreshed);
  return refreshed;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    migrateLooseFiles(projectId);
    const assets = await refreshFrameIOCommentCounts(projectId, readRegistry(projectId));
    return NextResponse.json({ assets });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const actor = resolveRequestActor(req);

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  let mediaDir: string;
  try {
    mediaDir = resolveProjectMediaStorageDir(projectId);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 507 });
  }
  fs.mkdirSync(mediaDir, { recursive: true });
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  const ingestQueue = getIngestQueue();

  // Use a pre-reserved job ID if the client sent one (multi-file batch flow),
  // otherwise create a job immediately from the x-upload-filename header so the
  // IngestTray opens before busboy has parsed any body bytes.
  const preReservedJobId = req.headers.get('x-ingest-job-id');
  const rawUploadFilename = req.headers.get('x-upload-filename');
  const earlyFilename = rawUploadFilename ? decodeURIComponent(rawUploadFilename) : null;
  let pendingJobId: string | null = preReservedJobId
    ?? (earlyFilename ? (ingestQueue?.add(projectId, earlyFilename) ?? null) : null);

  // If the pre-reserved job was cancelled before the upload even started,
  // bail out before the body is streamed — no point writing bytes we'll discard.
  if (preReservedJobId && ingestQueue?.isCancelled(preReservedJobId)) {
    return NextResponse.json({ uploads: [] });
  }

  return new Promise<NextResponse>((resolve) => {
    const bb = busboy({ headers: Object.fromEntries(req.headers) });
    const results: { assetId: string; filename: string; jobId: string }[] = [];
    const writes: Promise<void>[] = [];
    const formFields: Record<string, string> = {};
    let responseIssued = false;
    let pendingJobConsumed = false;

    bb.on('field', (field, value) => {
      formFields[field] = value;
    });

    bb.on('file', (_field, stream, info) => {
      const ext = path.extname(info.filename) || '';
      const tmpName = `upload-${Date.now()}${ext}`;
      const dest = path.join(mediaDir, tmpName);
      const replaceAssetId = formFields.replaceAssetId?.trim() || undefined;

      // Reuse the early job created from the header, or create one now if the
      // client didn't send the header (graceful fallback).
      const ingestJobId = (pendingJobId && !pendingJobConsumed)
        ? pendingJobId
        : (ingestQueue?.add(projectId, info.filename) ?? null);
      pendingJobConsumed = true;

      if (ingestJobId) ingestQueue?.setTempPath(ingestJobId, dest);
      let bytesWritten = 0;
      // Hash computed in-stream: no second file read needed after write completes
      const hash = createHash('sha256');

      stream.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        hash.update(chunk);
        if (ingestJobId && contentLength > 0) {
          const pct = Math.min(95, Math.round((bytesWritten / contentLength) * 100));
          ingestQueue?.setProgress(ingestJobId, pct);
        }
      });

      const write = new Promise<void>((res, rej) => {
        const out = fs.createWriteStream(dest);
        stream.pipe(out);
        out.on('finish', async () => {
          if (responseIssued) {
            try { fs.unlinkSync(dest); } catch { /* ignore */ }
            res();
            return;
          }

          if (ingestJobId && ingestQueue?.isCancelled(ingestJobId)) {
            try { fs.unlinkSync(dest); } catch { /* ignore */ }
            // setProgress() may have overwritten the status to 'ingesting' during
            // streaming — re-apply the cancel so the job doesn't stay stuck at 95%.
            ingestQueue?.cancel(ingestJobId);
            res();
            return;
          }

          try {
            // Hash was accumulated in-stream during the write — no second file read.
            const preComputedHash = !replaceAssetId ? `sha256:${hash.digest('hex')}` : null;

            const versionCandidate = !replaceAssetId
              ? findCanonicalVersionCandidate(projectId, info.filename, dest, preComputedHash)
              : null;

            if (versionCandidate?.duplicate) {
              responseIssued = true;
              try { fs.unlinkSync(dest); } catch { /* ignore */ }
              if (ingestJobId) ingestQueue?.fail(ingestJobId, 'Duplicate version');
              resolve(NextResponse.json({
                error: `This file already matches the current version of ${versionCandidate.asset.name}.`,
                code: 'duplicate_version',
                existingAsset: versionCandidate.asset,
              }, { status: 409 }));
              res();
              return;
            }

            if (versionCandidate) {
              responseIssued = true;
              try { fs.unlinkSync(dest); } catch { /* ignore */ }
              if (ingestJobId) ingestQueue?.setAwaitingConfirmation(ingestJobId);
              resolve(NextResponse.json({
                error: `This looks like a new version of ${versionCandidate.asset.name}. Confirm to replace the existing pipeline asset.`,
                code: 'version_confirmation_required',
                existingAsset: versionCandidate.asset,
                currentVersionNumber: versionCandidate.currentVersionNumber,
              }, { status: 409 }));
              res();
              return;
            }

            const stat = fs.statSync(dest);
            const asset = registerAsset({
              projectId,
              originalFilename: info.filename,
              filePath: dest,
              fileSize: stat.size,
              storageType: 'uploaded',
              existingAssetId: replaceAssetId,
              preComputedHash,
            });

            const stableName = `${asset.assetId}${ext}`;
            const stableDest = path.join(mediaDir, stableName);
            fs.renameSync(dest, stableDest);
            if (ingestJobId) ingestQueue?.setStablePath(ingestJobId, stableDest);
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

            // Probe duration in background — don't block the upload response
            probeDuration(stableDest).then((dur) => {
              if (dur != null) patchAsset(projectId, asset.assetId, { duration: dur });
            }).catch(() => {});

            if (ingestJobId) {
              ingestQueue?.setAssetId(ingestJobId, asset.assetId);
              ingestQueue?.complete(ingestJobId);
            }

            let jobId = '';
            try {
              const job = getTranscripterService().enqueue(projectId, stableDest, asset.assetId, asset.originalFilename);
              jobId = job.jobId;
              patchAsset(projectId, asset.assetId, {
                transcription: { status: 'queued', jobId, completedAt: null },
              });
            } catch (err) {
              console.error('[upload] failed to enqueue transcription:', err);
            }

            triggerFrameIOUpload(projectId, asset.assetId, {
              actor,
              clientId: project.clientName || null,
            });
            results.push({ assetId: asset.assetId, filename: info.filename, jobId });
            res();
          } catch (err) {
            const msg = (err as Error).message;
            console.error('[upload] post-stream processing failed for', info.filename, ':', msg);
            if (ingestJobId) ingestQueue?.fail(ingestJobId, `Post-stream error: ${msg}`);
            // Clean up temp file if it still exists (rename may not have happened)
            try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
            rej(err);
          }
        });
        out.on('error', (err) => {
          if (ingestJobId && !ingestQueue?.isCancelled(ingestJobId)) {
            ingestQueue?.fail(ingestJobId, (err as Error).message);
          }
          rej(err);
        });
      });

      writes.push(write);
    });

    bb.on('finish', async () => {
      // If no file field was received, fail any early job we created.
      if (!pendingJobConsumed && pendingJobId) {
        ingestQueue?.fail(pendingJobId, 'No file received');
      }
      if (responseIssued) return;
      await Promise.allSettled(writes);
      if (!responseIssued) {
        resolve(NextResponse.json({ uploads: results }));
      }
    });

    bb.on('error', (err) => {
      if (!pendingJobConsumed && pendingJobId) {
        ingestQueue?.fail(pendingJobId, (err as Error).message);
      }
      if (!responseIssued) {
        resolve(NextResponse.json({ error: (err as Error).message }, { status: 500 }));
      }
    });

    // Split the request body into ≤64 KB chunks before handing it to busboy.
    // Without this, a single massive chunk (e.g. a fully-buffered 2 GB+ body)
    // causes busboy to call Buffer.from(chunk) internally, which throws
    // ERR_OUT_OF_RANGE because Node.js buffers are capped at 2 147 483 647 bytes.
    const safeBodyStream = req.body!.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const MAX_CHUNK = 65536;
          for (let i = 0; i < chunk.byteLength; i += MAX_CHUNK) {
            controller.enqueue(chunk.subarray(i, Math.min(i + MAX_CHUNK, chunk.byteLength)));
          }
        },
      }),
    );

    const nodeStream = Readable.fromWeb(
      safeBodyStream as Parameters<typeof Readable.fromWeb>[0],
    );
    nodeStream.on('error', (err) => {
      if (!pendingJobConsumed && pendingJobId) {
        ingestQueue?.fail(pendingJobId, (err as Error).message);
      }
      if (!responseIssued) {
        responseIssued = true;
        resolve(NextResponse.json({ error: (err as Error).message }, { status: 500 }));
      }
    });
    nodeStream.pipe(bb);
  });
}
