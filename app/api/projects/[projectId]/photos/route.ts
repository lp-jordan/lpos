import { NextRequest, NextResponse } from 'next/server';
import busboy from 'busboy';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectStore } from '@/lib/services/container';
import { listPhotos, registerPhoto } from '@/lib/store/photo-registry';
import { resolveProjectPhotosStorageDir } from '@/lib/services/storage-volume-service';
import { extractCaptureDate } from '@/lib/services/photo-image-service';
import { PHOTO_EXTENSIONS, guessPhotoMime, type PhotoAsset } from '@/lib/models/photo-asset';

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const photos = listPhotos(projectId);
    return NextResponse.json({ photos });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId } = await params;

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  let photosDir: string;
  try {
    photosDir = resolveProjectPhotosStorageDir(projectId);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 507 });
  }

  return new Promise<NextResponse>((resolve) => {
    const bb = busboy({ headers: Object.fromEntries(req.headers) });
    const uploads: PhotoAsset[] = [];
    const writes: Promise<void>[] = [];
    let responseIssued = false;

    bb.on('file', (_field, stream, info) => {
      const ext = path.extname(info.filename).toLowerCase();
      if (!PHOTO_EXTENSIONS.has(ext)) {
        stream.resume();
        if (!responseIssued) {
          responseIssued = true;
          resolve(NextResponse.json(
            { error: `File type "${ext || '(none)'}" is not allowed. Only image files may be uploaded.` },
            { status: 415 },
          ));
        }
        return;
      }

      const photoId = randomUUID();
      const finalPath = path.join(photosDir, `${photoId}${ext}`);
      let bytesWritten = 0;

      const write = new Promise<void>((res, rej) => {
        const out = fs.createWriteStream(finalPath);
        stream.on('data', (chunk: Buffer) => { bytesWritten += chunk.length; });
        stream.pipe(out);
        out.on('finish', async () => {
          if (responseIssued) {
            try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
            res();
            return;
          }
          try {
            const captureDate = await extractCaptureDate(finalPath);
            const photo = registerPhoto({
              projectId,
              originalFilename: info.filename,
              filePath: finalPath,
              fileSize: bytesWritten,
              mimeType: info.mimeType || guessPhotoMime(info.filename),
              captureDate,
            });
            uploads.push(photo);
            res();
          } catch (err) {
            try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch { /* ignore */ }
            rej(err);
          }
        });
        out.on('error', (err) => rej(err));
      });

      writes.push(write);
    });

    bb.on('finish', async () => {
      if (responseIssued) return;
      const results = await Promise.allSettled(writes);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed && failed.status === 'rejected') {
        resolve(NextResponse.json({ error: (failed.reason as Error).message, uploads }, { status: 500 }));
        return;
      }
      resolve(NextResponse.json({ uploads }, { status: 201 }));
    });

    bb.on('error', (err) => {
      if (!responseIssued) {
        responseIssued = true;
        resolve(NextResponse.json({ error: (err as Error).message }, { status: 500 }));
      }
    });

    const safeBodyStream = req.body!.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const MAX_CHUNK = 65536;
          for (let i = 0; i < chunk.byteLength; i += MAX_CHUNK) {
            controller.enqueue(chunk.subarray(i, Math.min(i + MAX_CHUNK, chunk.byteLength)));
          }
        },
      }),
    );

    const nodeStream = Readable.fromWeb(
      safeBodyStream as Parameters<typeof Readable.fromWeb>[0],
    );
    nodeStream.on('error', (err) => {
      if (!responseIssued) {
        responseIssued = true;
        resolve(NextResponse.json({ error: (err as Error).message }, { status: 500 }));
      }
    });
    nodeStream.pipe(bb);
  });
}
