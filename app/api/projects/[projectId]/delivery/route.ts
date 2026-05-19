import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage';
import ffmpegPath from 'ffmpeg-static';
import { getProjectStore, getUploadQueueService } from '@/lib/services/container';
import { getAsset } from '@/lib/store/media-registry';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { getSession } from '@/lib/services/api-auth';
import { getUserById } from '@/lib/store/user-store';
import { activeDeliveryJobs, activeFfmpegProcs } from '@/lib/services/delivery-job-registry';

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
const DATA_DIR       = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data')

;['INGEST_BASE_URL', 'INGEST_API_KEY', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].forEach((k) => {
  if (!process.env[k]) console.error(`[delivery] ⚠ Missing env var: ${k}`)
})

// ── Module-level state ─────────────────────────────────────────────────────────
// Imported from delivery-job-registry so cancel endpoint shares the same Maps.

const VIDEO_MIME_TYPES = new Set([
  'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
  'video/webm', 'video/mxf', 'video/m4v', 'video/mts',
])

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
// Validates assets then runs a multi-phase background job:
//   Phase A — upload originals to R2
//   Register — create delivery link on ingest server (link goes live)
//   Phase B — upload available transcripts per video
//   Phase C — transcode proxy per video, upload, notify ingest as each completes
//
// Each phase checks for cancellation so the job can be aborted cleanly at any
// phase boundary. The delivery link is left intact with whatever was uploaded.
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
  // assetId = token (used by UploadTray to look up the cancel endpoint)
  const jobId = queue.add(projectId, token, label, 'delivery')

  activeDeliveryJobs.set(token, jobId)

  void (async () => {
    const mediaDir       = resolveProjectMediaStorageDir(projectId)
    const transcriptsDir = path.join(DATA_DIR, 'projects', projectId, 'transcripts')
    const subtitlesDir   = path.join(DATA_DIR, 'projects', projectId, 'subtitles')
    const total          = eligible.length
    const videoAssets: { asset: NonNullable<ReturnType<typeof getAsset>>; filename: string; r2Key: string }[] = []

    try {
      // ── Phase A: Upload originals ─────────────────────────────────────────────
      const r2Assets: {
        r2_key: string; filename: string; file_size: number; mime_type: string
        thumbnail_url?: string; thumbnail_r2_key?: string
      }[] = []

      queue.setProgress(jobId, 1, `Preparing ${total} file${total !== 1 ? 's' : ''}…`)

      for (let i = 0; i < total; i++) {
        if (queue.isCancelled(jobId)) { cleanup(token); return }

        const { asset, filename } = eligible[i]
        const filePath = asset.filePath!
        const fileSize = fs.statSync(filePath).size
        const ext      = path.extname(filePath).toLowerCase()
        const mimeType = asset.mimeType ?? mimeForExt(ext)
        const r2Key    = `delivery/${token}/${filename}`

        queue.setProgress(
          jobId,
          Math.round((i / total) * 55) + 1,
          `Uploading file ${i + 1} of ${total}…`,
        )

        await uploadToR2({ key: r2Key, filePath, mimeType })

        let thumbnailUrl: string | undefined
        let thumbnailR2Key: string | undefined

        if (asset.cloudflare?.uid) {
          thumbnailUrl = `https://videodelivery.net/${asset.cloudflare.uid}/thumbnails/thumbnail.jpg`
        } else {
          const thumbPath = path.join(mediaDir, `${asset.assetId}.thumb.jpg`)
          if (fs.existsSync(thumbPath)) {
            try {
              const thumbKey = `delivery/${token}/thumbs/${asset.assetId}.jpg`
              const thumbBuf = fs.readFileSync(thumbPath)
              await s3.send(new PutObjectCommand({
                Bucket: R2_BUCKET, Key: thumbKey, Body: thumbBuf, ContentType: 'image/jpeg',
              }))
              thumbnailR2Key = thumbKey
            } catch (err) {
              console.warn(`[delivery] thumbnail upload failed for ${asset.assetId}:`, err)
            }
          }
        }

        r2Assets.push({ r2_key: r2Key, filename, file_size: fileSize, mime_type: mimeType, thumbnail_url: thumbnailUrl, thumbnail_r2_key: thumbnailR2Key })

        if (isVideo(mimeType, ext)) {
          videoAssets.push({ asset, filename, r2Key })
        }

        queue.setProgress(
          jobId,
          Math.round(((i + 1) / total) * 55) + 1,
          `Uploaded ${i + 1} of ${total} file${total !== 1 ? 's' : ''}`,
        )
      }

      if (queue.isCancelled(jobId)) { cleanup(token); return }

      // ── Register: delivery link goes live ─────────────────────────────────────
      queue.setProgress(jobId, 58, 'Registering delivery link…')

      const ingestRes = await fetch(`${INGEST_URL}/api/delivery`, {
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

      if (!ingestRes.ok) {
        const text = await ingestRes.text().catch(() => '(unreadable)')
        console.error(`[delivery] ingest server ${ingestRes.status}: ${text}`)
        queue.fail(jobId, `Failed to register delivery link (${ingestRes.status})`)
        cleanup(token)
        return
      }

      queue.setProgress(jobId, 62, 'Delivery link live — uploading transcripts…')
      console.log(`[delivery] created token ${token} for project ${projectId}`)

      // ── Phase B: Upload transcripts ───────────────────────────────────────────
      for (const { asset, r2Key } of videoAssets) {
        if (queue.isCancelled(jobId)) { cleanup(token); return }

        const txJobId = asset.transcription?.jobId
        if (!txJobId || asset.transcription?.status !== 'done') continue

        const candidates: { localPath: string; kind: string; ext: string }[] = [
          { localPath: path.join(transcriptsDir, `${txJobId}.srt`), kind: 'srt', ext: 'srt' },
          { localPath: path.join(subtitlesDir,   `${txJobId}.vtt`), kind: 'vtt', ext: 'vtt' },
          { localPath: path.join(transcriptsDir, `${txJobId}.txt`), kind: 'txt', ext: 'txt' },
        ]

        const toUpload = candidates.filter(c => fs.existsSync(c.localPath))
        if (!toUpload.length) continue

        const uploadedTranscripts: { r2_key: string; filename: string; file_size: number; kind: string }[] = []
        const baseName = path.basename(asset.filePath!, path.extname(asset.filePath!))

        for (const { localPath, kind, ext } of toUpload) {
          const txR2Key   = `delivery/${token}/transcripts/${asset.assetId}_${kind}.${ext}`
          const txFilename = `${sanitize(baseName)}.${ext}`
          const txSize     = fs.statSync(localPath).size
          await uploadToR2({ key: txR2Key, filePath: localPath, mimeType: mimeForTranscriptKind(kind) })
          uploadedTranscripts.push({ r2_key: txR2Key, filename: txFilename, file_size: txSize, kind })
        }

        await fetch(`${INGEST_URL}/api/delivery/${token}/transcripts`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': INGEST_API_KEY },
          body:    JSON.stringify({ asset_r2_key: r2Key, transcripts: uploadedTranscripts }),
        }).catch(err => console.warn(`[delivery] transcript registration failed for ${asset.assetId}:`, err))
      }

      if (queue.isCancelled(jobId)) { cleanup(token); return }

      // ── Phase C: Transcode + upload proxies ───────────────────────────────────
      const videoTotal = videoAssets.length
      if (videoTotal > 0) {
        queue.setProgress(jobId, 68, `Transcoding ${videoTotal} proxy${videoTotal !== 1 ? 's' : ''}…`)
      }

      for (let i = 0; i < videoAssets.length; i++) {
        if (queue.isCancelled(jobId)) { cleanup(token); return }

        const { asset, filename, r2Key } = videoAssets[i]
        const baseName    = path.basename(filename, path.extname(filename))
        const proxyName   = `${baseName}_proxy.mp4`
        const proxyR2Key  = `delivery/${token}/${proxyName}`
        const tmpPath     = path.join(os.tmpdir(), `lpos-proxy-${jobId}-${i}.mp4`)
        const pctStart    = 68 + Math.round((i / videoTotal) * 30)

        queue.setProgress(jobId, pctStart, `Transcoding proxy ${i + 1} of ${videoTotal}: ${filename}…`)

        try {
          await transcodeProxy(asset.filePath!, tmpPath, jobId)

          if (queue.isCancelled(jobId)) {
            fs.rmSync(tmpPath, { force: true })
            cleanup(token)
            return
          }

          queue.setProgress(jobId, pctStart + Math.round(30 / videoTotal * 0.5), `Uploading proxy ${i + 1} of ${videoTotal}…`)

          const proxySize = fs.statSync(tmpPath).size
          await uploadToR2({ key: proxyR2Key, filePath: tmpPath, mimeType: 'video/mp4' })
          fs.rmSync(tmpPath, { force: true })

          await fetch(`${INGEST_URL}/api/delivery/${token}/assets/proxy`, {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json', 'x-api-key': INGEST_API_KEY },
            body:    JSON.stringify({ r2_key: r2Key, proxy_r2_key: proxyR2Key, proxy_file_size: proxySize }),
          }).catch(err => console.warn(`[delivery] proxy registration failed for ${asset.assetId}:`, err))

          queue.setProgress(
            jobId,
            68 + Math.round(((i + 1) / videoTotal) * 30),
            `Proxy ready: ${filename}`,
          )
        } catch (err) {
          fs.rmSync(tmpPath, { force: true })
          if (queue.isCancelled(jobId)) { cleanup(token); return }
          console.warn(`[delivery] proxy transcode failed for ${asset.assetId}:`, err)
          // Non-fatal — continue with remaining assets
        }
      }

      queue.setProgress(jobId, 100, 'All proxies ready')
      setTimeout(() => queue.complete(jobId), 1500)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[delivery] job ${jobId} failed:`, message)
      if (!queue.isCancelled(jobId)) queue.fail(jobId, message)
    } finally {
      cleanup(token)
    }
  })()

  return NextResponse.json({ ok: true, jobId, token, ineligible })
}

// ── Transcode ──────────────────────────────────────────────────────────────────

function transcodeProxy(inputPath: string, outputPath: string, jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) { reject(new Error('ffmpeg-static binary not found')); return }

    const proc = spawn(ffmpegPath, [
      '-nostdin',
      '-i', inputPath,
      '-vf', 'scale=min(1920\\,iw):-2',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '28',
      '-maxrate', '4M',
      '-bufsize', '8M',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    activeFfmpegProcs.set(jobId, proc)

    let stderrBuf = ''
    proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })

    proc.on('close', (code) => {
      activeFfmpegProcs.delete(jobId)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderrBuf.slice(-300)}`))
    })
    proc.on('error', (err) => {
      activeFfmpegProcs.delete(jobId)
      reject(err)
    })
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function cleanup(token: string) {
  activeDeliveryJobs.delete(token)
}

function isVideo(mimeType: string, ext: string): boolean {
  if (VIDEO_MIME_TYPES.has(mimeType)) return true
  return ['.mp4', '.mov', '.avi', '.mkv', '.mxf', '.webm', '.m4v', '.mts'].includes(ext)
}

async function uploadToR2({ key, filePath, mimeType }: { key: string; filePath: string; mimeType: string }): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket:      R2_BUCKET,
      Key:         key,
      Body:        fs.createReadStream(filePath),
      ContentType: mimeType,
    },
  })
  await upload.done()
}

function sanitize(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._\-() ]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 200) || 'file'
}

function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    '.mp4':  'video/mp4',    '.mov':  'video/quicktime',
    '.avi':  'video/x-msvideo', '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',   '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',    '.aac':  'audio/aac',
    '.flac': 'audio/flac',   '.pdf':  'application/pdf',
    '.jpg':  'image/jpeg',   '.jpeg': 'image/jpeg',
    '.png':  'image/png',
  }
  return map[ext] ?? 'application/octet-stream'
}

function mimeForTranscriptKind(kind: string): string {
  if (kind === 'srt') return 'application/x-subrip'
  if (kind === 'vtt') return 'text/vtt'
  return 'text/plain'
}

