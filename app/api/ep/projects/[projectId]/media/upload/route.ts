import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectStore, getIngestQueueService } from '@/lib/services/container';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { getIngestQueueDb } from '@/lib/store/ingest-queue-db';
import { ALLOWED_UPLOAD_EXTENSIONS } from '@/lib/upload-constants';
import { requireEpToken } from '@/lib/services/ep-auth';

/**
 * EditPanel-authenticated (X-EP-Token) chunked upload — INIT.
 *
 * Mirrors the session-auth POST /api/projects/:id/media/upload, with two
 * differences:
 *   1. Auth is requireEpToken (machine token) rather than the session cookie.
 *   2. EditPanel does not pre-reserve an ingest-queue job, so we create one
 *      here via ingestQueue.add(). Everything downstream (chunk PATCH, finalize,
 *      asset registration, transcode/thumbnail/Frame.io) is the shared pipeline,
 *      so a render uploaded here behaves exactly like a browser upload and shows
 *      up in the LPOS IngestTray.
 *
 * The chunk/finalize boilerplate is duplicated (rather than refactored into the
 * live browser routes) deliberately, to keep the production browser path
 * byte-for-byte unchanged.
 */

function getIngestQueue() {
  try { return getIngestQueueService(); } catch { return null; }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const { projectId } = await params;

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  let body: { filename?: unknown; fileSize?: unknown; replaceAssetId?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { filename, fileSize, replaceAssetId } = body;

  if (typeof filename !== 'string' || !filename.trim()) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 });
  }
  if (typeof fileSize !== 'number' || fileSize <= 0) {
    return NextResponse.json({ error: 'fileSize must be a positive number' }, { status: 400 });
  }

  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    return NextResponse.json(
      { error: `File type "${ext || '(none)'}" is not allowed. Only video and audio files may be uploaded.` },
      { status: 415 },
    );
  }

  const ingestQueue = getIngestQueue();
  if (!ingestQueue) return NextResponse.json({ error: 'Ingest queue unavailable' }, { status: 503 });

  let mediaDir: string;
  try {
    mediaDir = resolveProjectMediaStorageDir(projectId);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 507 });
  }
  fs.mkdirSync(mediaDir, { recursive: true });

  // EditPanel-originated ingest job — surfaces in the LPOS IngestTray with progress.
  const jobId = ingestQueue.add(projectId, filename, undefined, fileSize);

  const uploadId = randomUUID();
  const tempPath = path.join(mediaDir, `chunk-upload-${uploadId}${ext}`);

  // Create empty file to reserve the path.
  const fh = await fs.promises.open(tempPath, 'w');
  await fh.close();

  const db = getIngestQueueDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO upload_sessions
      (upload_id, job_id, project_id, filename, file_size, bytes_received, temp_path,
       replace_asset_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'uploading', ?, ?)
  `).run(
    uploadId,
    jobId,
    projectId,
    filename,
    fileSize,
    tempPath,
    typeof replaceAssetId === 'string' ? replaceAssetId : null,
    now,
    now,
  );

  ingestQueue.setTempPath(jobId, tempPath);

  return NextResponse.json({ uploadId, jobId, bytesReceived: 0 }, { status: 201 });
}
