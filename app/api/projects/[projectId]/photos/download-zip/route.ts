import { NextRequest, NextResponse } from 'next/server';
import archiver from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { getPhoto } from '@/lib/store/photo-registry';

type Ctx = { params: Promise<{ projectId: string }> };

function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) { used.add(name); return name; }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let i = 1;
  while (used.has(`${base} (${i})${ext}`)) i += 1;
  const final = `${base} (${i})${ext}`;
  used.add(final);
  return final;
}

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const body = await req.json() as { photoIds: string[]; zipName?: string };

    if (!Array.isArray(body.photoIds) || body.photoIds.length === 0) {
      return NextResponse.json({ error: 'photoIds (non-empty array) is required' }, { status: 400 });
    }

    const photos = body.photoIds
      .map((id) => getPhoto(projectId, id))
      .filter((p): p is NonNullable<typeof p> => p !== null && fs.existsSync(p.filePath));

    if (photos.length === 0) {
      return NextResponse.json({ error: 'No matching photos found on disk' }, { status: 404 });
    }

    const passthrough = new PassThrough();
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => passthrough.destroy(err));
    archive.pipe(passthrough);

    const used = new Set<string>();
    for (const photo of photos) {
      const name = uniqueName(used, photo.originalFilename);
      archive.file(photo.filePath, { name });
    }
    archive.finalize();

    const zipName = (body.zipName?.trim() || 'photos') + '.zip';

    return new NextResponse(
      Readable.toWeb(passthrough) as unknown as ReadableStream,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${zipName.replace(/"/g, '\\"')}"`,
        },
      },
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
