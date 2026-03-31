import { NextRequest, NextResponse } from 'next/server';
import busboy from 'busboy';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPresentationService } from '@/lib/services/container';
import { convertPptxToImages, convertPdfToImages, PRESENTATION_TEMP_DIR } from '@/lib/services/presentation-service';

const ACCEPTED_EXTENSIONS = ['.pptx', '.pdf'];

export async function POST(req: NextRequest) {
  return new Promise<NextResponse>((resolve) => {
    const bb = busboy({ headers: Object.fromEntries(req.headers) });

    let originalName = 'Presentation';
    let uploadedPath: string | null = null;
    let uploadedExt: string | null = null;
    let uploadDir: string | null = null;
    let fileReceived = false;
    let earlyReject = false;

    bb.on('file', (_field, stream, info) => {
      const ext = path.extname(info.filename).toLowerCase();

      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        stream.resume(); // discard bytes
        earlyReject = true;
        resolve(NextResponse.json({ error: 'Only .pptx or .pdf files are supported' }, { status: 400 }));
        return;
      }

      fileReceived = true;
      originalName = path.basename(info.filename, ext) || 'Presentation';
      uploadedExt = ext;

      const id = randomUUID();
      uploadDir = path.join(PRESENTATION_TEMP_DIR, id);
      fs.mkdirSync(uploadDir, { recursive: true });
      uploadedPath = path.join(uploadDir, `upload${ext}`);

      const out = fs.createWriteStream(uploadedPath);
      stream.pipe(out);

      out.on('error', (err) => {
        resolve(NextResponse.json({ error: err.message }, { status: 500 }));
      });
    });

    bb.on('finish', async () => {
      if (earlyReject) return;

      if (!fileReceived || !uploadedPath || !uploadedExt || !uploadDir) {
        resolve(NextResponse.json({ error: 'No file received' }, { status: 400 }));
        return;
      }

      try {
        const slideDir = path.join(uploadDir, 'slides');
        const slides = uploadedExt === '.pdf'
          ? await convertPdfToImages(uploadedPath, slideDir)
          : await convertPptxToImages(uploadedPath, slideDir);

        // Clean up source file — slides are all we need
        try { fs.unlinkSync(uploadedPath); } catch { /* ignore */ }

        if (slides.length === 0) {
          resolve(NextResponse.json({ error: 'Conversion produced no slides' }, { status: 422 }));
          return;
        }

        getPresentationService().loadPresentation(originalName, slides);
        resolve(NextResponse.json({ name: originalName, totalSlides: slides.length }));
      } catch (err) {
        resolve(NextResponse.json({ error: (err as Error).message }, { status: 500 }));
      }
    });

    bb.on('error', (err) => {
      resolve(NextResponse.json({ error: (err as Error).message }, { status: 500 }));
    });

    // Stream body → busboy using the same chunked pattern as the media upload route
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
      resolve(NextResponse.json({ error: (err as Error).message }, { status: 500 }));
    });
    nodeStream.pipe(bb);
  });
}
