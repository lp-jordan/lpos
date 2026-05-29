import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import type { ActivityActor } from '@/lib/models/activity';
import { getProjectStore, getIngestQueueService } from '@/lib/services/container';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { getIngestQueueDb } from '@/lib/store/ingest-queue-db';
import { finalizeUploadedAsset, hashFile } from '@/lib/services/media-finalization';
import { requireEpToken } from '@/lib/services/ep-auth';

/**
 * EditPanel-authenticated (X-EP-Token) chunked upload — FINALIZE.
 * Mirrors the session-auth finalize route. The only behavioural difference is
 * the activity actor: instead of resolveRequestActor(req) (which reads session
 * headers), we attribute the upload to the EP token's user.
 */

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
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

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

  // Attribute the upload to the signed-in EditPanel user (token-bound).
  const actor: ActivityActor = {
    actor_type: 'user',
    actor_id: auth.user.id,
    actor_display: auth.user.name || auth.user.email,
  };

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

  // EditPanel uploads carry their sign-off from the pre-export confirm screen, so
  // an EP-token upload must NEVER bounce to "awaiting confirmation" in the LPOS
  // IngestTray. If LPOS flags a version candidate, auto-register the upload as a
  // new version of that asset (re-finalize with the candidate's id). The
  // version_confirmation_required path returns before any registration/rename, so
  // the temp file is intact and re-finalizing is safe.
  if (result.outcome === 'version_confirmation_required') {
    const candidateId = result.existingAsset.assetId;
    try {
      result = await finalizeUploadedAsset({
        projectId,
        project,
        filename: session.filename,
        tempPath: session.temp_path,
        mediaDir,
        preComputedHash,
        replaceAssetId: candidateId,
        jobId: session.job_id,
        actor,
      });
    } catch (err) {
      const msg = (err as Error).message;
      ingestQueue?.fail(session.job_id, `Finalization error: ${msg}`);
      try { if (fs.existsSync(session.temp_path)) fs.unlinkSync(session.temp_path); } catch { /* ignore */ }
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  const now = new Date().toISOString();

  // Byte-identical to the current version — nothing to register. Treat as a clean
  // no-op (not a failure) so EditPanel marks the file handled rather than failed.
  if (result.outcome === 'duplicate') {
    try { fs.unlinkSync(session.temp_path); } catch { /* already gone */ }
    db.prepare("UPDATE upload_sessions SET status = 'finalized', updated_at = ? WHERE upload_id = ?")
      .run(now, uploadId);
    ingestQueue?.complete(session.job_id);
    return NextResponse.json({ asset: result.asset, code: 'no_change_needed' });
  }

  if (result.outcome !== 'registered') {
    ingestQueue?.fail(session.job_id, 'Unexpected finalization outcome');
    return NextResponse.json({ error: 'Unexpected finalization outcome' }, { status: 500 });
  }

  // Registered — a brand-new asset or a new version of an existing one.
  db.prepare("UPDATE upload_sessions SET status = 'finalized', updated_at = ? WHERE upload_id = ?")
    .run(now, uploadId);
  getProjectStore().touch(projectId);
  return NextResponse.json({ asset: result.asset });
}
