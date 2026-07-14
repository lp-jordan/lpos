import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { getProjectStore } from '@/lib/services/container';
import { getAsset } from '@/lib/store/media-registry';
import { INGEST_URL, INGEST_API_KEY, assetVersionOf } from '@/lib/services/delivery-upload';

type Ctx = { params: Promise<{ projectId: string; token: string }> }

interface IngestItem {
  id:            number
  asset_id:      string | null
  asset_version: number | null
  r2_key:        string
  filename:      string
  file_size:     number
  mime_type:     string
  thumbnail_url: string | null
  proxy_r2_key:  string | null
}

// GET /api/projects/[projectId]/delivery/[token]/items
// Lists the videos in a delivery link, enriched with the asset's current version
// so the UI can flag which items are stale (and thus refreshable). Items created
// before version tracking (asset_id === null) are never flagged stale.
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, token } = await params

  const project = getProjectStore().getById(projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const res = await fetch(`${INGEST_URL}/api/delivery/${token}/items`, {
    headers: { 'x-api-key': INGEST_API_KEY },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)')
    return NextResponse.json({ error: `Failed to fetch items (${res.status}): ${text}` }, { status: 502 })
  }

  const items = await res.json() as IngestItem[]

  const enriched = items.map((it) => {
    const asset = it.asset_id ? getAsset(projectId, it.asset_id) : null
    const currentVersion = asset ? assetVersionOf(asset) : null
    const hasLocalFile = !!asset?.filePath && fs.existsSync(asset.filePath)
    const isStale = it.asset_version != null && currentVersion != null && currentVersion > it.asset_version
    return {
      id:              it.id,
      assetId:         it.asset_id,
      filename:        it.filename,
      fileSize:        it.file_size,
      mimeType:        it.mime_type,
      thumbnailUrl:    it.thumbnail_url,
      deliveredVersion: it.asset_version,
      currentVersion,
      // Refreshable only when it's stale AND we still have the latest bytes on disk.
      isStale,
      canRefresh:      isStale && hasLocalFile,
      missingLocalFile: isStale && !hasLocalFile,
    }
  })

  const staleCount       = enriched.filter((e) => e.isStale).length
  const refreshableCount = enriched.filter((e) => e.canRefresh).length

  return NextResponse.json({ items: enriched, staleCount, refreshableCount })
}
