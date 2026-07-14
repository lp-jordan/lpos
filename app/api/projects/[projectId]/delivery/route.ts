import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getProjectStore, getUploadQueueService } from '@/lib/services/container';
import { getSession } from '@/lib/services/api-auth';
import { getUserById } from '@/lib/store/user-store';
import { activeDeliveryJobs } from '@/lib/services/delivery-job-registry';
import {
  deliverAssets, resolveEligible,
  INGEST_URL, INGEST_API_KEY,
  type R2AssetRecord,
} from '@/lib/services/delivery-upload';

type Ctx = { params: Promise<{ projectId: string }> }

// GET /api/projects/[projectId]/delivery
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId } = await params

  const project = getProjectStore().getById(projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const res = await fetch(
    `${INGEST_URL}/api/delivery?project_name=${encodeURIComponent(project.name)}`,
    { headers: { 'x-api-key': INGEST_API_KEY } },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)')
    console.error(`[delivery] GET ingest ${res.status}: ${text}`)
    return NextResponse.json({ error: `Failed to fetch delivery links (${res.status}): ${text}` }, { status: 502 })
  }

  const links = await res.json()
  return NextResponse.json({ links })
}

// POST /api/projects/[projectId]/delivery
// Body: { assetIds, label?, clientName?, expiresAt }
//
// Validates assets then runs the shared multi-phase copy job (see
// lib/services/delivery-upload.ts). The register step creates the link on the
// ingest server so it goes live once the originals are uploaded.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId } = await params

  const project = getProjectStore().getById(projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const session = await getSession(req)
  const creator = session ? getUserById(session.userId) : null
  const createdByUserEmail = creator?.email ?? null

  const body = await req.json() as {
    assetIds:    string[]
    label?:      string
    clientName?: string
    expiresAt:   string
  }

  if (!Array.isArray(body.assetIds) || !body.assetIds.length) {
    return NextResponse.json({ error: 'assetIds is required' }, { status: 400 })
  }
  if (!body.expiresAt) {
    return NextResponse.json({ error: 'expiresAt is required' }, { status: 400 })
  }

  const { eligible, ineligible } = resolveEligible(projectId, body.assetIds)
  if (!eligible.length) {
    return NextResponse.json({ error: 'No eligible assets to deliver', ineligible }, { status: 422 })
  }

  const token = randomUUID()
  const label = body.label?.trim() || project.name
  const queue = getUploadQueueService()
  // assetId = token (used by UploadTray to look up the cancel endpoint)
  const jobId = queue.add(projectId, token, label, 'delivery')

  activeDeliveryJobs.set(token, jobId)

  void deliverAssets({
    projectId, token, jobId, queue, eligible,
    register: async (r2Assets: R2AssetRecord[]) => {
      const res = await fetch(`${INGEST_URL}/api/delivery`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': INGEST_API_KEY },
        body: JSON.stringify({
          token,
          project_name:          project.name,
          client_name:           body.clientName?.trim() || null,
          label:                 body.label?.trim()       || null,
          expires_at:            body.expiresAt,
          assets:                r2Assets,
          created_by_user_email: createdByUserEmail,
          project_id:            projectId,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '(unreadable)')
        console.error(`[delivery] ingest server ${res.status}: ${text}`)
        return { ok: false, error: `Failed to register delivery link (${res.status})` }
      }
      return { ok: true }
    },
  })

  return NextResponse.json({ ok: true, jobId, token, ineligible })
}
