import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore, getUploadQueueService } from '@/lib/services/container';
import { activeDeliveryJobs } from '@/lib/services/delivery-job-registry';
import {
  deliverAssets, resolveEligible,
  INGEST_URL, INGEST_API_KEY,
  type R2AssetRecord,
} from '@/lib/services/delivery-upload';

type Ctx = { params: Promise<{ projectId: string; token: string }> }

// POST /api/projects/[projectId]/delivery/[token]/assets
// Body: { assetIds: string[] }
//
// Adds videos to an EXISTING delivery link. Uploads the new originals under the
// same token and appends rows on the ingest server. The link URL is unchanged.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId, token } = await params

  const project = getProjectStore().getById(projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  if (activeDeliveryJobs.has(token)) {
    return NextResponse.json({ error: 'This delivery link is still processing — try again in a moment.' }, { status: 409 })
  }

  const body = await req.json() as { assetIds: string[] }
  if (!Array.isArray(body.assetIds) || !body.assetIds.length) {
    return NextResponse.json({ error: 'assetIds is required' }, { status: 400 })
  }

  const { eligible, ineligible } = resolveEligible(projectId, body.assetIds)
  if (!eligible.length) {
    return NextResponse.json({ error: 'No eligible assets to add', ineligible }, { status: 422 })
  }

  const queue = getUploadQueueService()
  const label = `${project.name} (+${eligible.length})`
  const jobId = queue.add(projectId, token, label, 'delivery')

  activeDeliveryJobs.set(token, jobId)

  void deliverAssets({
    projectId, token, jobId, queue, eligible,
    register: async (r2Assets: R2AssetRecord[]) => {
      const res = await fetch(`${INGEST_URL}/api/delivery/${token}/assets`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': INGEST_API_KEY },
        body:    JSON.stringify({ assets: r2Assets }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '(unreadable)')
        console.error(`[delivery] add-assets ingest ${res.status}: ${text}`)
        return { ok: false, error: `Failed to add videos (${res.status})` }
      }
      return { ok: true }
    },
  })

  return NextResponse.json({ ok: true, jobId, token, added: eligible.length, ineligible })
}
