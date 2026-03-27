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
 * POST body: { filenames: string[] }
 * Response:  { jobs: { filename: string; jobId: string }[] }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const body = await req.json() as { filenames?: string[] };
  const filenames = Array.isArray(body.filenames)
    ? body.filenames.filter((f): f is string => typeof f === 'string' && f.length > 0)
    : [];

  if (!filenames.length) {
    return NextResponse.json({ jobs: [] });
  }

  const ingestQueue = getIngestQueue();
  if (!ingestQueue) {
    return NextResponse.json({ error: 'Ingest queue not available' }, { status: 503 });
  }

  const batchId = randomUUID();
  const jobs = filenames.map((filename) => ({
    filename,
    jobId: ingestQueue.add(projectId, filename, batchId),
  }));

  return NextResponse.json({ jobs });
}
