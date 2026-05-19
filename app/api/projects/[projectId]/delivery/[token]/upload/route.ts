import { NextRequest, NextResponse } from 'next/server';
import { getUploadQueueService } from '@/lib/services/container';
import { activeDeliveryJobs, activeFfmpegProcs } from '@/lib/services/delivery-job-registry';

type Ctx = { params: Promise<{ projectId: string; token: string }> }

// DELETE /api/projects/[projectId]/delivery/[token]/upload
// Cancels an in-progress delivery upload job. The delivery link is left intact
// with whatever files were already uploaded to R2 and registered with ingest.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { token } = await params

  const jobId = activeDeliveryJobs.get(token)
  if (!jobId) {
    return NextResponse.json({ error: 'No active upload for this delivery' }, { status: 404 })
  }

  const queue = getUploadQueueService()
  queue.cancel(jobId)

  // Kill any in-progress ffmpeg transcode immediately
  const proc = activeFfmpegProcs.get(jobId)
  if (proc) {
    proc.kill('SIGTERM')
  }

  return NextResponse.json({ ok: true })
}
