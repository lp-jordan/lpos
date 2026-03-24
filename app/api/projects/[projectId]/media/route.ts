import { NextRequest, NextResponse } from 'next/server';
import busboy from 'busboy';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectStore, getTranscripterService, getIngestQueueService } from '@/lib/services/container';
import {
  readRegistry, registerAsset, migrateLooseFiles, patchAsset, writeRegistry,
} from '@/lib/store/media-registry';
import { getComments } from '@/lib/services/frameio';
import { triggerFrameIOUpload } from '@/lib/services/frameio-upload';
import type { MediaAsset } from '@/lib/models/media-asset';
import { findCanonicalVersionCandidate } from '@/lib/store/canonical-asset-store';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';

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

  return new Promise<NextResponse>((resolve) => {
    const bb = busboy({ headers: Object.fromEntries(req.headers) });
    const results: { assetId: string; filename: string; jobId: string }[] = [];
    const writes: Promise<void>[] = [];
    const formFields: Record<string, string> = {};
    let responseIssued = false;

    bb.on('field', (field, value) => {
      formFields[field] = value;
    });

    bb.on('file', (_field, stream, info) => {
      const ext = path.extname(info.filename) || '';
      const tmpName = `upload-${Date.now()}${ext}`;
      const dest = path.join(mediaDir, tmpName);
      const replaceAssetId = formFields.replaceAssetId?.trim() || undefined;
      const ingestQueue = getIngestQueue();
      const ingestJobId = ingestQueue?.add(projectId, info.filename) ?? null;
      let bytesWritten = 0;

      stream.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (ingestJobId && contentLength > 0) {
          const pct = Math.min(95, Math.round((bytesWritten / contentLength) * 100));
          ingestQueue?.setProgress(ingestJobId, pct);
        }
      });

      const write = new Promise<void>((res, rej) => {
        const out = fs.createWriteStream(dest);
        stream.pipe(out);
        out.on('finish', () => {
          if (responseIssued) {
            try { fs.unlinkSync(dest); } catch { /* ignore */ }
            res();
            return;
          }

          if (ingestJobId && ingestQueue?.isCancelled(ingestJobId)) {
            try { fs.unlinkSync(dest); } catch { /* ignore */ }
            res();
            return;
          }

          const versionCandidate = !replaceAssetId
            ? findCanonicalVersionCandidate(projectId, info.filename, dest)
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
            if (ingestJobId) ingestQueue?.fail(ingestJobId, 'Confirmation required');
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
          });

          const stableName = `${asset.assetId}${ext}`;
          const stableDest = path.join(mediaDir, stableName);
          fs.renameSync(dest, stableDest);
          patchAsset(projectId, asset.assetId, { filePath: stableDest });

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

          triggerFrameIOUpload(projectId, asset.assetId);
          results.push({ assetId: asset.assetId, filename: info.filename, jobId });
          res();
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
      if (responseIssued) return;
      await Promise.allSettled(writes);
      if (!responseIssued) {
        resolve(NextResponse.json({ uploads: results }));
      }
    });

    bb.on('error', (err) => {
      if (!responseIssued) {
        resolve(NextResponse.json({ error: (err as Error).message }, { status: 500 }));
      }
    });

    Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]).pipe(bb);
  });
}
