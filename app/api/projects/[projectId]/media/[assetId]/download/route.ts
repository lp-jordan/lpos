/**
 * GET /api/projects/[projectId]/media/[assetId]/download
 *
 * Serves a local media file as an attachment so the browser prompts a save
 * dialog instead of attempting inline playback. No Range request handling —
 * for streaming with seek support use the /stream route instead.
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

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  const asset = getAsset(projectId, assetId);
  if (!asset)          return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  if (!asset.filePath) return NextResponse.json({ error: 'No file path' },    { status: 404 });

  const filePath = asset.filePath;

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
  }

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME_MAP[ext] ?? asset.mimeType ?? 'application/octet-stream';
  const fileSize = fs.statSync(filePath).size;
  const filename = asset.originalFilename ?? asset.name;

  const stream = fs.createReadStream(filePath);
  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type':        mimeType,
      'Content-Length':      String(fileSize),
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '\\"')}"`,
    },
  });
}
