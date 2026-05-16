import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { getPhoto } from '@/lib/store/photo-registry';
import { ensurePreview } from '@/lib/services/photo-image-service';

type Ctx = { params: Promise<{ projectId: string; photoId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, photoId } = await params;
    const photo = getPhoto(projectId, photoId);
    if (!photo) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!fs.existsSync(photo.filePath)) {
      return NextResponse.json({ error: 'Source file missing' }, { status: 404 });
    }

    const previewPath = await ensurePreview(projectId, photoId, photo.filePath);
    const stream = fs.createReadStream(previewPath);
    const size = fs.statSync(previewPath).size;
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(size),
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
