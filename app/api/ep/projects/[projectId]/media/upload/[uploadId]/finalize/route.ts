import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import type { ActivityActor } from '@/lib/models/activity';
import type { EditpanelRenderInfo } from '@/lib/models/media-asset';
import { getProjectStore, getIngestQueueService } from '@/lib/services/container';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { getIngestQueueDb } from '@/lib/store/ingest-queue-db';
import { finalizeUploadedAsset, hashFile } from '@/lib/services/media-finalization';
import { requireEpToken } from '@/lib/services/ep-auth';
import path from 'node:path';

/**
 * EditPanel-authenticated (X-EP-Token) chunked upload — FINALIZE.
 * Mirrors the session-auth finalize route. The only behavioural difference is
 * the activity actor: instead of resolveRequestActor(req) (which reads session
 * headers), we attribute the upload to the EP token's user.
 */

// ─── TEMP DIAGNOSTIC — remove after the 95% finalize-stall investigation ──────
// The server's stdout isn't captured to a readable file, so we append timestamped
// checkpoints to data/finalize-trace.log instead. This lets us see, for any
// EditPanel push: whether the finalize request even arrived, and exactly which
// step (hash / register / rename) it dies on. Delete this block + its call sites
// once the root cause is confirmed.
const TRACE_PATH = path.join(
  process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data'),
  'finalize-trace.log',
);
function trace(uploadId: string, msg: string): void {
  try {
    fs.appendFileSync(TRACE_PATH, `${new Date().toISOString()}  [${uploadId.slice(0, 8)}]  ${msg}\n`);
  } catch { /* diagnostic only — never break finalize */ }
}

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

/**
 * Parse the optional `renderMeta` field from the finalize request body.
 *
 * Returns:
 *  - `EditpanelRenderInfo` when body present + renderMeta valid → persisted to editorial_links
 *  - `null` when body is missing/empty OR renderMeta not present → browser uploads, old editpanel clients
 *  - throws on present-but-malformed renderMeta → caller returns 400 (loud failure for editpanel bugs)
 *
 * Lenient on absence (old clients keep working), strict on shape (new clients can't silently corrupt the tether).
 */
async function parseRenderMeta(req: NextRequest): Promise<EditpanelRenderInfo | null> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return null; // empty / invalid JSON body → treat as no renderMeta
  }
  if (!raw || typeof raw !== 'object') return null;
  const renderMeta = (raw as { renderMeta?: unknown }).renderMeta;
  if (renderMeta === undefined || renderMeta === null) return null;
  if (typeof renderMeta !== 'object') {
    throw new Error('renderMeta must be an object');
  }
  const m = renderMeta as Record<string, unknown>;
  const requiredString = (key: string): string => {
    const v = m[key];
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`renderMeta.${key} must be a non-empty string`);
    }
    return v;
  };
  const fps = m.timelineFps;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    throw new Error('renderMeta.timelineFps must be a positive number');
  }
  const renderedFromMachine = m.renderedFromMachine;
  if (renderedFromMachine !== null && renderedFromMachine !== undefined && typeof renderedFromMachine !== 'string') {
    throw new Error('renderMeta.renderedFromMachine must be a string or null');
  }
  return {
    timelineUid: requiredString('timelineUid'),
    timelineName: requiredString('timelineName'),
    timelineStartTimecode: requiredString('timelineStartTimecode'),
    timelineFps: fps,
    resolveProjectName: requiredString('resolveProjectName'),
    renderedAt: requiredString('renderedAt'),
    renderedFromMachine: (renderedFromMachine as string | null | undefined) ?? null,
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; uploadId: string }> },
) {
  trace('--------', 'REQUEST received');
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) { trace('--------', 'auth FAILED'); return auth; }

  const { projectId, uploadId } = await params;
  trace(uploadId, `ENTER project=${projectId}`);

  // Parse optional renderMeta from the body BEFORE doing any other work — bad body
  // is a client bug and should 400 loudly rather than failing mid-finalize. Note:
  // req.json() consumes the body, so this must happen before any other read.
  let editpanelRender: EditpanelRenderInfo | null;
  try {
    editpanelRender = await parseRenderMeta(req);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const db = getIngestQueueDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE upload_id = ?',
  ).get(uploadId) as UploadSessionRow | undefined;

  if (!session) {
    trace(uploadId, 'session NOT FOUND');
    return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  }
  trace(uploadId, `session "${session.filename}" status=${session.status} bytes=${session.bytes_received}/${session.file_size}`);
  if (session.status !== 'uploading') {
    trace(uploadId, `reject: session is ${session.status}`);
    return NextResponse.json({ error: `Upload session is ${session.status}` }, { status: 409 });
  }

  if (session.bytes_received !== session.file_size) {
    trace(uploadId, 'reject: incomplete (bytes < size)');
    return NextResponse.json(
      { code: 'incomplete', bytesReceived: session.bytes_received, fileSize: session.file_size },
      { status: 409 },
    );
  }

  const ingestQueue = getIngestQueue();
  if (ingestQueue?.isCancelled(session.job_id)) {
    trace(uploadId, 'reject: job cancelled');
    try { fs.unlinkSync(session.temp_path); } catch { /* already gone */ }
    const now = new Date().toISOString();
    db.prepare("UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE upload_id = ?")
      .run(now, uploadId);
    ingestQueue.cancel(session.job_id);
    return NextResponse.json({ code: 'job_cancelled' }, { status: 409 });
  }

  ingestQueue?.setProgress(session.job_id, 95, 'Registering asset…');
  trace(uploadId, 'set progress 95 — registering');

  const project = getProjectStore().getById(projectId);
  if (!project) { trace(uploadId, 'project NOT FOUND'); return NextResponse.json({ error: 'Project not found' }, { status: 404 }); }

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
    trace(uploadId, `mediaDir ERROR: ${(err as Error).message}`);
    return NextResponse.json({ error: (err as Error).message }, { status: 507 });
  }

  let preComputedHash: string;
  trace(uploadId, 'hash START');
  const _hashT0 = Date.now();
  try {
    preComputedHash = await hashFile(session.temp_path);
  } catch (err) {
    trace(uploadId, `hash ERROR (${Date.now() - _hashT0}ms): ${(err as Error).message}`);
    ingestQueue?.fail(session.job_id, `Hash failed: ${(err as Error).message}`);
    return NextResponse.json({ error: 'Failed to hash uploaded file' }, { status: 500 });
  }
  trace(uploadId, `hash DONE (${Date.now() - _hashT0}ms)`);

  let result: Awaited<ReturnType<typeof finalizeUploadedAsset>>;
  trace(uploadId, 'finalize START (register + rename)');
  const _finT0 = Date.now();
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
      editpanelRender,
    });
  } catch (err) {
    const msg = (err as Error).message;
    trace(uploadId, `finalize ERROR (${Date.now() - _finT0}ms): ${msg}`);
    ingestQueue?.fail(session.job_id, `Finalization error: ${msg}`);
    try { if (fs.existsSync(session.temp_path)) fs.unlinkSync(session.temp_path); } catch { /* ignore */ }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  trace(uploadId, `finalize DONE (${Date.now() - _finT0}ms) outcome=${result.outcome}`);

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
        editpanelRender,
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
    trace(uploadId, 'DONE — duplicate (no change needed)');
    return NextResponse.json({ asset: result.asset, code: 'no_change_needed' });
  }

  if (result.outcome !== 'registered') {
    trace(uploadId, `DONE — unexpected outcome=${result.outcome}`);
    ingestQueue?.fail(session.job_id, 'Unexpected finalization outcome');
    return NextResponse.json({ error: 'Unexpected finalization outcome' }, { status: 500 });
  }

  // Registered — a brand-new asset or a new version of an existing one.
  db.prepare("UPDATE upload_sessions SET status = 'finalized', updated_at = ? WHERE upload_id = ?")
    .run(now, uploadId);
  getProjectStore().touch(projectId);
  trace(uploadId, `DONE — registered asset=${result.asset.assetId}`);
  return NextResponse.json({ asset: result.asset });
}
