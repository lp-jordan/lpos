import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { getPhoto } from '@/lib/store/photo-registry';

type Ctx = { params: Promise<{ projectId: string; photoId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, photoId } = await params;
  const photo = getPhoto(projectId, photoId);
  if (!photo) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!fs.existsSync(photo.filePath)) {
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
  }

  const fileSize = fs.statSync(photo.filePath).size;
  const stream = fs.createReadStream(photo.filePath);
  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': photo.mimeType || 'application/octet-stream',
      'Content-Length': String(fileSize),
      'Content-Disposition': `attachment; filename="${photo.originalFilename.replace(/"/g, '\\"')}"`,
    },
  });
}
