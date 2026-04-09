import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { cacheFtpPlaybackFile, getCachedPlaybackFile } from '@/lib/services/slate-playback-cache';

// Video files can be large — allow up to 5 minutes for the FTP download to complete.
export const maxDuration = 300;

const MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
};

export async function POST(req: NextRequest) {
  const body = await req.json() as { host?: string; remotePath?: string };
  const host = body.host?.trim();
  const remotePath = body.remotePath?.trim();

  if (!host || !remotePath) {
    return NextResponse.json({ error: 'host and remotePath are required' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const sseEvent = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const cached = await cacheFtpPlaybackFile(host, remotePath, (received, total) => {
          const percent = Math.min(99, Math.round((received / total) * 100));
          controller.enqueue(sseEvent({ percent }));
        });

        controller.enqueue(sseEvent({
          done: true,
          cacheKey: cached.cacheKey,
          playbackUrl: `/api/slate/playback?key=${encodeURIComponent(cached.cacheKey)}`,
          filename: cached.filename,
        }));
      } catch (err) {
        controller.enqueue(sseEvent({ error: (err as Error).message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')?.trim();
  if (!key) {
    return NextResponse.json({ error: 'key is required' }, { status: 400 });
  }

  const cached = await getCachedPlaybackFile(key);
  if (!cached) {
    return NextResponse.json({ error: 'Cached playback file not found' }, { status: 404 });
  }

  if (!fs.existsSync(cached.filePath)) {
    return NextResponse.json({ error: 'Cached playback file not found on disk' }, { status: 404 });
  }

  const ext = path.extname(cached.filePath).toLowerCase();
  const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';
  const fileSize = fs.statSync(cached.filePath).size;
  const rangeHeader = req.headers.get('range');

  if (!rangeHeader) {
    const stream = fs.createReadStream(cached.filePath);
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
  const start = parseInt(startStr, 10);
  const end = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024 - 1, fileSize - 1);

  if (start >= fileSize) {
    return new NextResponse(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` },
    });
  }

  const chunkSize = end - start + 1;
  const stream = fs.createReadStream(cached.filePath, { start, end });

  return new NextResponse(stream as unknown as ReadableStream, {
    status: 206,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(chunkSize),
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
