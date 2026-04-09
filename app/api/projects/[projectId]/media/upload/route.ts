import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectStore, getIngestQueueService } from '@/lib/services/container';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { getIngestQueueDb } from '@/lib/store/ingest-queue-db';
import { ALLOWED_UPLOAD_EXTENSIONS } from '@/lib/upload-constants';

function getIngestQueue() {
  try { return getIngestQueueService(); } catch { return null; }
}

interface UploadSessionRow {
  upload_id: string;
  bytes_received: number;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  let body: { filename?: unknown; fileSize?: unknown; jobId?: unknown; replaceAssetId?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { filename, fileSize, jobId, replaceAssetId } = body;

  if (typeof filename !== 'string' || !filename.trim()) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 });
  }
  if (typeof fileSize !== 'number' || fileSize <= 0) {
    return NextResponse.json({ error: 'fileSize must be a positive number' }, { status: 400 });
  }
  if (typeof jobId !== 'string' || !jobId.trim()) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
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

  if (ingestQueue.isCancelled(jobId as string)) {
    return NextResponse.json({ error: 'Job has been cancelled' }, { status: 409 });
  }

  const db = getIngestQueueDb();

  // Idempotent: if a session already exists for this job, return it so the client resumes.
  const existing = db.prepare(
    "SELECT upload_id, bytes_received FROM upload_sessions WHERE job_id = ? AND status = 'uploading' LIMIT 1",
  ).get(jobId) as UploadSessionRow | undefined;

  if (existing) {
    return NextResponse.json({ uploadId: existing.upload_id, bytesReceived: existing.bytes_received });
  }

  let mediaDir: string;
  try {
    mediaDir = resolveProjectMediaStorageDir(projectId);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 507 });
  }
  fs.mkdirSync(mediaDir, { recursive: true });

  const uploadId = randomUUID();
  const tempPath = path.join(mediaDir, `chunk-upload-${uploadId}${ext}`);

  // Create empty file to reserve the path.
  const fh = await fs.promises.open(tempPath, 'w');
  await fh.close();

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

  ingestQueue.setTempPath(jobId as string, tempPath);

  return NextResponse.json({ uploadId, bytesReceived: 0 }, { status: 201 });
}
