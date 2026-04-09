import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { getProjectStore, getIngestQueueService } from '@/lib/services/container';
import { resolveRequestActor } from '@/lib/services/activity-actor';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { getIngestQueueDb } from '@/lib/store/ingest-queue-db';
import { finalizeUploadedAsset, hashFile } from '@/lib/services/media-finalization';

function getIngestQueue() {
  try { return getIngestQueueService(); } catch { return null; }
}

interface UploadSessionRow {
  upload_id: string;
  job_id: string;
  project_id: string;
  filename: string;
  file_size: number;
  bytes_received: number;
  temp_path: string;
  replace_asset_id: string | null;
  status: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; uploadId: string }> },
) {
  const { projectId, uploadId } = await params;
  const db = getIngestQueueDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE upload_id = ?',
  ).get(uploadId) as UploadSessionRow | undefined;

  if (!session) {
    return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  }
  if (session.status !== 'uploading') {
    return NextResponse.json({ error: `Upload session is ${session.status}` }, { status: 409 });
  }

  if (session.bytes_received !== session.file_size) {
    return NextResponse.json(
      { code: 'incomplete', bytesReceived: session.bytes_received, fileSize: session.file_size },
      { status: 409 },
    );
  }

  const ingestQueue = getIngestQueue();
  if (ingestQueue?.isCancelled(session.job_id)) {
    try { fs.unlinkSync(session.temp_path); } catch { /* already gone */ }
    const now = new Date().toISOString();
    db.prepare("UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE upload_id = ?")
      .run(now, uploadId);
    ingestQueue.cancel(session.job_id);
    return NextResponse.json({ code: 'job_cancelled' }, { status: 409 });
  }

  ingestQueue?.setProgress(session.job_id, 95, 'Registering asset…');

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const actor = resolveRequestActor(req);

  let mediaDir: string;
  try {
    mediaDir = resolveProjectMediaStorageDir(projectId);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 507 });
  }

  let preComputedHash: string;
  try {
    preComputedHash = await hashFile(session.temp_path);
  } catch (err) {
    ingestQueue?.fail(session.job_id, `Hash failed: ${(err as Error).message}`);
    return NextResponse.json({ error: 'Failed to hash uploaded file' }, { status: 500 });
  }

  let result: Awaited<ReturnType<typeof finalizeUploadedAsset>>;
  try {
    result = await finalizeUploadedAsset({
      projectId,
      project,
      filename: session.filename,
      tempPath: session.temp_path,
      mediaDir,
      preComputedHash,
      replaceAssetId: session.replace_asset_id ?? undefined,
      jobId: session.job_id,
      actor,
    });
  } catch (err) {
    const msg = (err as Error).message;
    ingestQueue?.fail(session.job_id, `Finalization error: ${msg}`);
    try { if (fs.existsSync(session.temp_path)) fs.unlinkSync(session.temp_path); } catch { /* ignore */ }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const now = new Date().toISOString();

  if (result.outcome === 'duplicate') {
    try { fs.unlinkSync(session.temp_path); } catch { /* already gone */ }
    db.prepare("UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE upload_id = ?")
      .run(now, uploadId);
    ingestQueue?.fail(session.job_id, 'Duplicate version');
    return NextResponse.json({
      error: `This file already matches the current version of ${result.asset.name}.`,
      code: 'duplicate_version',
      existingAsset: result.asset,
    }, { status: 409 });
  }

  if (result.outcome === 'version_confirmation_required') {
    // Hold temp file — user must confirm or decline via the confirm endpoint.
    db.prepare(`
      UPDATE upload_sessions
      SET status = 'awaiting_confirmation', version_meta_json = ?, updated_at = ?
      WHERE upload_id = ?
    `).run(
      JSON.stringify({
        existingAsset: result.existingAsset,
        currentVersionNumber: result.currentVersionNumber,
      }),
      now,
      uploadId,
    );
    ingestQueue?.setAwaitingConfirmation(session.job_id);
    return NextResponse.json({
      error: `This looks like a new version of ${result.existingAsset.name}. Confirm to replace the existing pipeline asset.`,
      code: 'version_confirmation_required',
      existingAsset: result.existingAsset,
      currentVersionNumber: result.currentVersionNumber,
      uploadId,
    }, { status: 409 });
  }

  // Registered successfully.
  db.prepare("UPDATE upload_sessions SET status = 'finalized', updated_at = ? WHERE upload_id = ?")
    .run(now, uploadId);
  return NextResponse.json({ asset: result.asset });
}
