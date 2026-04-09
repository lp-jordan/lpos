import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getIngestQueueService } from '@/lib/services/container';

function getIngestQueue() {
  try { return getIngestQueueService(); } catch { return null; }
}

/**
 * Reserve ingest queue entries for a batch of files before uploading begins.
 * Returns a job ID per filename so the IngestTray can show all pending files
 * as "queued" immediately — even files that haven't started uploading yet.
 *
 * POST body: { files: { filename: string; size: number }[] }
 *            or legacy: { filenames: string[] }
 * Response:  { jobs: { filename: string; jobId: string }[] }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const body = await req.json() as {
    files?: { filename: string; size?: number }[];
    filenames?: string[];
  };

  // Normalise to a unified list — accept new `files` shape or legacy `filenames`.
  let fileEntries: { filename: string; size?: number }[] = [];
  if (Array.isArray(body.files)) {
    fileEntries = body.files.filter(
      (f): f is { filename: string; size?: number } =>
        typeof f === 'object' && f !== null && typeof f.filename === 'string' && f.filename.length > 0,
    );
  } else if (Array.isArray(body.filenames)) {
    fileEntries = body.filenames
      .filter((f): f is string => typeof f === 'string' && f.length > 0)
      .map((filename) => ({ filename }));
  }

  if (!fileEntries.length) {
    return NextResponse.json({ jobs: [] });
  }

  const ingestQueue = getIngestQueue();
  if (!ingestQueue) {
    return NextResponse.json({ error: 'Ingest queue not available' }, { status: 503 });
  }

  const batchId = randomUUID();
  const jobs = fileEntries.map(({ filename, size }) => ({
    filename,
    jobId: ingestQueue.add(projectId, filename, batchId, size),
  }));

  return NextResponse.json({ jobs });
}
