import { NextRequest, NextResponse } from 'next/server';
import { getAsset, patchAsset } from '@/lib/store/media-registry';
import { isSardiusConfigured, uploadToSardius, checkSardiusFileExists } from '@/lib/services/sardius-ftp';
import type { SardiusMetadata } from '@/lib/services/sardius-ftp';
import { getUploadQueueService } from '@/lib/services/container';

function buildSuggestedName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? `${filename}(1)` : `${filename.slice(0, dot)}(1)${filename.slice(dot)}`;
}

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  return NextResponse.json({ sardius: asset.sardius });
}

export interface SardiusPushBody {
  remoteDir: string;
  metadata: SardiusMetadata;
  overwrite?: boolean;
  filenameOverride?: string;
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  if (!asset.filePath) {
    return NextResponse.json(
      { error: 'No local file path — cannot push to Sardius.' },
      { status: 400 },
    );
  }
  if (!isSardiusConfigured()) {
    return NextResponse.json(
      { error: 'Sardius FTP credentials are not configured on this LPOS host.' },
      { status: 501 },
    );
  }
  if (asset.sardius.status === 'uploading') {
    return NextResponse.json({ error: 'A Sardius upload is already in progress.' }, { status: 409 });
  }

  const body = await req.json() as SardiusPushBody;
  if (!body.remoteDir?.trim()) {
    return NextResponse.json({ error: 'remoteDir is required.' }, { status: 400 });
  }

  const remoteDir = body.remoteDir.trim();
  const baseFilename = asset.originalFilename;
  const localFilePath = asset.filePath;

  // Collision check — skip if caller already acknowledged with overwrite or filenameOverride
  if (!body.overwrite && !body.filenameOverride) {
    const exists = await checkSardiusFileExists(remoteDir, baseFilename);
    if (exists) {
      return NextResponse.json(
        { conflict: true, suggestedName: buildSuggestedName(baseFilename) },
        { status: 409 },
      );
    }
  }

  const filename = body.filenameOverride?.trim() || baseFilename;

  const queue = getUploadQueueService();
  const jobId = queue.add(projectId, assetId, filename, 'sardius');

  patchAsset(projectId, assetId, {
    sardius: {
      status:         'uploading',
      remotePath:     remoteDir,
      remoteFilename: filename,
      lastError:      null,
    },
  });

  // Fire-and-forget background upload
  void (async () => {
    try {
      await uploadToSardius(localFilePath, remoteDir, filename, body.metadata, (pct) => {
        queue.setProgress(jobId, pct, `FTP → ${remoteDir}`);
      });
      patchAsset(projectId, assetId, {
        sardius: { status: 'queued', uploadedAt: new Date().toISOString(), lastError: null },
      });
      queue.setProcessing(jobId, 'In Sardius watch folder');
      setTimeout(() => queue.complete(jobId), 2000);
      console.log(`[sardius] uploaded ${filename} to ${remoteDir}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sardius] upload failed for ${assetId}:`, message);
      patchAsset(projectId, assetId, { sardius: { status: 'failed', lastError: message } });
      queue.fail(jobId, message);
    }
  })();

  return NextResponse.json({ ok: true, status: 'uploading' });
}

export interface SardiusUrlPatchBody {
  shareUrl: string;
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const body = await req.json() as SardiusUrlPatchBody;
  if (!body.shareUrl?.trim()) {
    return NextResponse.json({ error: 'shareUrl is required.' }, { status: 400 });
  }

  const updated = patchAsset(projectId, assetId, {
    sardius: { status: 'ready', shareUrl: body.shareUrl.trim() },
  });

  return NextResponse.json({ ok: true, sardius: updated?.sardius });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const updated = patchAsset(projectId, assetId, {
    sardius: {
      status:         'none',
      remotePath:     null,
      remoteFilename: null,
      shareUrl:       null,
      uploadedAt:     null,
      lastError:      null,
    },
  });

  return NextResponse.json({ ok: true, sardius: updated?.sardius });
}
