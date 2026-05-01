import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getProjectStore, getUploadQueueService } from '@/lib/services/container';
import { getAsset } from '@/lib/store/media-registry';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
})

const INGEST_URL     = (process.env.INGEST_BASE_URL ?? '').replace(/\/$/, '')
const INGEST_API_KEY = process.env.INGEST_API_KEY!
const R2_BUCKET      = process.env.R2_BUCKET!

// Log missing env vars at startup so they show up in server logs immediately
;['INGEST_BASE_URL', 'INGEST_API_KEY', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].forEach((k) => {
  if (!process.env[k]) console.error(`[delivery] ⚠ Missing env var: ${k}`)
})

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
// Validates assets, enqueues a delivery job, then returns immediately.
// The background task uploads files to R2 and registers the link with the ingest server.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId } = await params

  const project = getProjectStore().getById(projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

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

  // Resolve assets and split eligible / ineligible before queuing
  const eligible:   { asset: NonNullable<ReturnType<typeof getAsset>>; filename: string }[] = []
  const ineligible: { assetId: string; name: string; reason: string }[] = []

  for (const assetId of body.assetIds) {
    const asset = getAsset(projectId, assetId)
    if (!asset) {
      ineligible.push({ assetId, name: assetId, reason: 'Asset not found' })
      continue
    }
    if (!asset.filePath) {
      ineligible.push({ assetId, name: asset.name, reason: 'No local file — may only exist on Frame.io' })
      continue
    }
    if (!fs.existsSync(asset.filePath)) {
      ineligible.push({ assetId, name: asset.name, reason: 'File not found on disk' })
      continue
    }
    eligible.push({ asset, filename: sanitize(asset.originalFilename ?? asset.name) })
  }

  if (!eligible.length) {
    return NextResponse.json({ error: 'No eligible assets to deliver', ineligible }, { status: 422 })
  }

  const token = randomUUID()
  const label = body.label?.trim() || project.name
  const queue = getUploadQueueService()
  // Use the token as the assetId field — it uniquely identifies this delivery job
  const jobId = queue.add(projectId, token, label, 'delivery')

  // Fire-and-forget: upload to R2 then register with ingest server
  void (async () => {
    try {
      const r2Assets: { r2_key: string; filename: string; file_size: number; mime_type: string; thumbnail_url?: string; thumbnail_r2_key?: string }[] = []
      const mediaDir = resolveProjectMediaStorageDir(projectId)
      const total = eligible.length

      queue.setProgress(jobId, 1, `Preparing ${total} file${total !== 1 ? 's' : ''}…`)

      for (let i = 0; i < total; i++) {
        const { asset, filename } = eligible[i]
        const filePath  = asset.filePath!
        const fileSize  = fs.statSync(filePath).size
        const ext       = path.extname(filePath).toLowerCase()
        const mimeType  = asset.mimeType ?? mimeForExt(ext)
        const r2Key     = `delivery/${token}/${filename}`

        queue.setProgress(
          jobId,
          Math.round((i / total) * 88) + 1,
          `Uploading file ${i + 1} of ${total}…`,
        )

        await s3.send(new PutObjectCommand({
          Bucket:        R2_BUCKET,
          Key:           r2Key,
          Body:          fs.createReadStream(filePath) as unknown as ReadableStream,
          ContentType:   mimeType,
          ContentLength: fileSize,
        }))

        // ── Thumbnail ──────────────────────────────────────────────────────────
        let thumbnailUrl: string | undefined
        let thumbnailR2Key: string | undefined

        if (asset.cloudflare?.uid) {
          // Cloudflare Stream — thumbnail is served directly from their CDN, no upload needed
          thumbnailUrl = `https://videodelivery.net/${asset.cloudflare.uid}/thumbnails/thumbnail.jpg`
        } else {
          // Local thumb — generated by FFmpeg at ingest time
          const thumbPath = path.join(mediaDir, `${asset.assetId}.thumb.jpg`)
          if (fs.existsSync(thumbPath)) {
            try {
              const thumbKey  = `delivery/${token}/thumbs/${asset.assetId}.jpg`
              const thumbBuf  = fs.readFileSync(thumbPath)
              await s3.send(new PutObjectCommand({
                Bucket:      R2_BUCKET,
                Key:         thumbKey,
                Body:        thumbBuf,
                ContentType: 'image/jpeg',
              }))
              thumbnailR2Key = thumbKey
            } catch (err) {
              console.warn(`[delivery] thumbnail upload failed for ${asset.assetId}:`, err)
            }
          }
        }
        // ──────────────────────────────────────────────────────────────────────

        r2Assets.push({ r2_key: r2Key, filename, file_size: fileSize, mime_type: mimeType, thumbnail_url: thumbnailUrl, thumbnail_r2_key: thumbnailR2Key })

        // Report completion of this file
        queue.setProgress(
          jobId,
          Math.round(((i + 1) / total) * 88) + 1,
          `Uploaded ${i + 1} of ${total} file${total !== 1 ? 's' : ''}`,
        )
      }

      queue.setProgress(jobId, 95, 'Registering delivery link…')

      const ingestRes = await fetch(`${INGEST_URL}/api/delivery`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': INGEST_API_KEY },
        body: JSON.stringify({
          token,
          project_name: project.name,
          client_name:  body.clientName?.trim() || null,
          label:        body.label?.trim()       || null,
          expires_at:   body.expiresAt,
          assets:       r2Assets,
        }),
      })

      if (!ingestRes.ok) {
        const text = await ingestRes.text().catch(() => '(unreadable)')
        console.error(`[delivery] ingest server ${ingestRes.status}: ${text}`)
        queue.fail(jobId, `Failed to register delivery link (${ingestRes.status})`)
        return
      }

      queue.setProcessing(jobId, 'Delivery link ready')
      setTimeout(() => queue.complete(jobId), 1500)
      console.log(`[delivery] created token ${token} for project ${projectId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[delivery] job ${jobId} failed:`, message)
      queue.fail(jobId, message)
    }
  })()

  return NextResponse.json({ ok: true, jobId, token, ineligible })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitize(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._\-() ]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 200) || 'file'
}

function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    '.mp4':  'video/mp4',
    '.mov':  'video/quicktime',
    '.avi':  'video/x-msvideo',
    '.mkv':  'video/x-matroska',
    '.webm': 'video/webm',
    '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',
    '.aac':  'audio/aac',
    '.flac': 'audio/flac',
    '.pdf':  'application/pdf',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
  }
  return map[ext] ?? 'application/octet-stream'
}
