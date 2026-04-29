import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;

  try {
    const mediaDir = resolveProjectMediaStorageDir(projectId);
    const thumbPath = path.join(mediaDir, `${assetId}.thumb.jpg`);

    if (!fs.existsSync(thumbPath)) {
      return new NextResponse(null, { status: 404 });
    }

    const buffer = await fs.promises.readFile(thumbPath);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
