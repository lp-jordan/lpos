import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { getProjectStore, getUploadQueueService } from '@/lib/services/container';
import { getAsset } from '@/lib/store/media-registry';
import { activeDeliveryJobs } from '@/lib/services/delivery-job-registry';
import {
  deliverAssets, assetVersionOf,
  INGEST_URL, INGEST_API_KEY,
  type EligibleAsset, type R2AssetRecord,
} from '@/lib/services/delivery-upload';

type Ctx = { params: Promise<{ projectId: string; token: string }> }

interface IngestItem {
  asset_id:      string | null
  asset_version: number | null
  r2_key:        string
  filename:      string
}

// POST /api/projects/[projectId]/delivery/[token]/refresh
//
// Rebuilds every stale item in a delivery link from its asset's *current*
// version, overwriting the existing R2 objects in place. The link URL, filenames
// and R2 keys are unchanged — a client re-opening the link just gets the new cut.
// Items with no tracked asset (created before version tracking) are skipped.
export async function POST(_req: NextRequest, { params }: Ctx) {
  const { projectId, token } = await params

  const project = getProjectStore().getById(projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  if (activeDeliveryJobs.has(token)) {
    return NextResponse.json({ error: 'This delivery link is still processing — try again in a moment.' }, { status: 409 })
  }

  const itemsRes = await fetch(`${INGEST_URL}/api/delivery/${token}/items`, {
    headers: { 'x-api-key': INGEST_API_KEY },
  })
  if (!itemsRes.ok) {
    const text = await itemsRes.text().catch(() => '(unreadable)')
    return NextResponse.json({ error: `Failed to load link items (${itemsRes.status}): ${text}` }, { status: 502 })
  }
  const items = await itemsRes.json() as IngestItem[]

  // Refresh candidates: tracked, advanced, and the latest bytes are on disk.
  // Reuse the EXISTING filename so the R2 keys line up and bytes overwrite in place.
  const eligible: EligibleAsset[] = []
  const skipped:  { filename: string; reason: string }[] = []

  for (const it of items) {
    if (!it.asset_id || it.asset_version == null) continue // untracked — not refreshable
    const asset = getAsset(projectId, it.asset_id)
    if (!asset) { skipped.push({ filename: it.filename, reason: 'Asset no longer exists' }); continue }
    if (assetVersionOf(asset) <= it.asset_version) continue // already latest
    if (!asset.filePath || !fs.existsSync(asset.filePath)) {
      skipped.push({ filename: it.filename, reason: 'Latest version not available on disk' })
      continue
    }
    eligible.push({ asset, filename: it.filename })
  }

  if (!eligible.length) {
    return NextResponse.json({ ok: true, refreshed: 0, skipped })
  }

  const queue = getUploadQueueService()
  const label = `${project.name} (refresh ×${eligible.length})`
  const jobId = queue.add(projectId, token, label, 'delivery')

  activeDeliveryJobs.set(token, jobId)

  void deliverAssets({
    projectId, token, jobId, queue, eligible,
    register: async (r2Assets: R2AssetRecord[]) => {
      const res = await fetch(`${INGEST_URL}/api/delivery/${token}/assets/refresh`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': INGEST_API_KEY },
        body:    JSON.stringify({
          assets: r2Assets.map((a) => ({
            r2_key: a.r2_key, file_size: a.file_size, mime_type: a.mime_type, asset_version: a.asset_version,
          })),
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '(unreadable)')
        console.error(`[delivery] refresh ingest ${res.status}: ${text}`)
        return { ok: false, error: `Failed to refresh delivery link (${res.status})` }
      }
      return { ok: true }
    },
  })

  return NextResponse.json({ ok: true, jobId, token, refreshed: eligible.length, skipped })
}
