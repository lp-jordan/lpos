/**
 * GET /api/projects/[projectId]/media/[assetId]/stream
 *
 * Streams a local media file with HTTP Range support so the browser's
 * <video> element can seek freely. Only serves files registered in the
 * media registry and accessible from the server's filesystem.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs   from 'node:fs';
import path from 'node:path';
import { getAsset } from '@/lib/store/media-registry';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

const MIME_MAP: Record<string, string> = {
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
  '.avi':  'video/x-msvideo',
  '.mkv':  'video/x-matroska',
  '.webm': 'video/webm',
  '.m4v':  'video/mp4',
  '.mts':  'video/mp2t',
  '.mxf':  'application/mxf',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.aac':  'audio/aac',
  '.flac': 'audio/flac',
};

export async function GET(req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset)           return NextResponse.json({ error: 'Asset not found' },    { status: 404 });
  if (!asset.filePath)  return NextResponse.json({ error: 'No file path' },       { status: 404 });

  const filePath = asset.filePath;

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
  }

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME_MAP[ext] ?? asset.mimeType ?? 'application/octet-stream';
  const fileSize = fs.statSync(filePath).size;

  const rangeHeader = req.headers.get('range');

  if (!rangeHeader) {
    // Full file response
    const stream = fs.createReadStream(filePath);
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type':   mimeType,
        'Content-Length': String(fileSize),
        'Accept-Ranges':  'bytes',
      },
    });
  }

  // ── Range request (seek support) ──────────────────────────────────────────
  const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
  const start = parseInt(startStr, 10);
  const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024 - 1, fileSize - 1);

  if (start >= fileSize) {
    return new NextResponse(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` },
    });
  }

  const chunkSize = end - start + 1;
  const stream    = fs.createReadStream(filePath, { start, end });

  return new NextResponse(stream as unknown as ReadableStream, {
    status: 206,
    headers: {
      'Content-Type':   mimeType,
      'Content-Length': String(chunkSize),
      'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':  'bytes',
    },
  });
}
