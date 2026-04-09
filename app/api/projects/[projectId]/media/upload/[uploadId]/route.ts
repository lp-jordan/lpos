import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { getIngestQueueService } from '@/lib/services/container';
import { getIngestQueueDb } from '@/lib/store/ingest-queue-db';

function getIngestQueue() {
  try { return getIngestQueueService(); } catch { return null; }
}

interface UploadSessionRow {
  upload_id: string;
  job_id: string;
  project_id: string;
  file_size: number;
  bytes_received: number;
  temp_path: string;
  status: string;
}

// ── PATCH — receive a chunk ────────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; uploadId: string }> },
) {
  const { uploadId } = await params;
  const db = getIngestQueueDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE upload_id = ?',
  ).get(uploadId) as UploadSessionRow | undefined;

  if (!session) {
    return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  }
  if (session.status === 'finalized' || session.status === 'cancelled') {
    return NextResponse.json({ error: `Upload session is ${session.status}` }, { status: 410 });
  }
  if (session.status !== 'uploading') {
    return NextResponse.json({ error: `Upload session is ${session.status}` }, { status: 409 });
  }

  const uploadOffsetHeader = req.headers.get('upload-offset');
  if (uploadOffsetHeader === null) {
    return NextResponse.json({ error: 'Upload-Offset header is required' }, { status: 400 });
  }
  const uploadOffset = parseInt(uploadOffsetHeader, 10);
  if (isNaN(uploadOffset) || uploadOffset < 0) {
    return NextResponse.json({ error: 'Invalid Upload-Offset' }, { status: 400 });
  }

  if (uploadOffset !== session.bytes_received) {
    return NextResponse.json(
      { code: 'offset_mismatch', expected: session.bytes_received },
      { status: 409 },
    );
  }

  const ingestQueue = getIngestQueue();
  if (ingestQueue?.isCancelled(session.job_id)) {
    const now = new Date().toISOString();
    db.prepare("UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE upload_id = ?")
      .run(now, uploadId);
    try { fs.unlinkSync(session.temp_path); } catch { /* already gone */ }
    return NextResponse.json({ code: 'job_cancelled' }, { status: 409 });
  }

  if (!req.body) {
    return NextResponse.json({ error: 'Request body is required' }, { status: 400 });
  }

  // Write chunk at the correct byte offset.
  const writeStream = fs.createWriteStream(session.temp_path, { flags: 'r+', start: uploadOffset });
  const nodeStream = Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]);

  let chunkBytesWritten = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      nodeStream.on('data', (chunk: Buffer) => { chunkBytesWritten += chunk.length; });
      nodeStream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      nodeStream.on('error', reject);
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const newTotal = uploadOffset + chunkBytesWritten;
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE upload_sessions SET bytes_received = ?, updated_at = ? WHERE upload_id = ?',
  ).run(newTotal, now, uploadId);

  const pct = session.file_size > 0
    ? Math.min(95, Math.round((newTotal / session.file_size) * 100))
    : 0;
  ingestQueue?.setProgress(session.job_id, pct);

  return NextResponse.json({ bytesReceived: newTotal });
}

// ── DELETE — abort upload ──────────────────────────────────────────────────────

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; uploadId: string }> },
) {
  const { uploadId } = await params;
  const db = getIngestQueueDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE upload_id = ?',
  ).get(uploadId) as UploadSessionRow | undefined;

  if (!session) {
    return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  }
  if (session.status === 'finalized') {
    return NextResponse.json({ error: 'Upload already finalized' }, { status: 409 });
  }

  try { fs.unlinkSync(session.temp_path); } catch { /* already gone */ }

  const now = new Date().toISOString();
  db.prepare("UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE upload_id = ?")
    .run(now, uploadId);

  getIngestQueue()?.cancel(session.job_id);

  return new NextResponse(null, { status: 204 });
}
