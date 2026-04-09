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
  temp_path: string;
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
  if (session.status !== 'awaiting_confirmation') {
    return NextResponse.json({ error: `Upload session is ${session.status}` }, { status: 409 });
  }

  let body: { replaceAssetId?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { replaceAssetId } = body;
  if (typeof replaceAssetId !== 'string' || !replaceAssetId.trim()) {
    return NextResponse.json({ error: 'replaceAssetId is required' }, { status: 400 });
  }

  // Verify temp file still exists — the 7-day sweep may have cleaned it.
  try {
    await fs.promises.access(session.temp_path);
  } catch {
    const now = new Date().toISOString();
    db.prepare("UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE upload_id = ?")
      .run(now, uploadId);
    getIngestQueue()?.fail(session.job_id, 'Temp file no longer available — please re-upload');
    return NextResponse.json({ code: 'temp_file_missing' }, { status: 409 });
  }

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const actor = resolveRequestActor(req);

  let mediaDir: string;
  try {
    mediaDir = resolveProjectMediaStorageDir(projectId);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 507 });
  }

  const ingestQueue = getIngestQueue();
  ingestQueue?.setProgress(session.job_id, 95, 'Registering asset…');

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
      replaceAssetId,
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
  db.prepare("UPDATE upload_sessions SET status = 'finalized', updated_at = ? WHERE upload_id = ?")
    .run(now, uploadId);

  // outcome should always be 'registered' here since replaceAssetId bypasses
  // version-conflict detection in finalizeUploadedAsset.
  if (result.outcome !== 'registered') {
    return NextResponse.json({ error: 'Unexpected finalization outcome' }, { status: 500 });
  }

  return NextResponse.json({ asset: result.asset });
}
