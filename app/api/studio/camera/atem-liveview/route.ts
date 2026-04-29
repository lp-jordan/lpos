import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { NextResponse } from 'next/server';
import { readStudioConfig } from '@/lib/store/studio-config-store';

export const dynamic = 'force-dynamic';

const BOUNDARY = 'atemlive';

export async function GET() {
  if (!ffmpegPath) {
    return NextResponse.json({ error: 'ffmpeg not available' }, { status: 503 });
  }

  const cfg = readStudioConfig();
  const deviceIndex = (cfg.camera.atemVideoDeviceIndex ?? '').trim() || '0';

  const proc = spawn(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'avfoundation',
    '-framerate', '24000/1001',
    '-pixel_format', 'uyvy422',
    '-i', `${deviceIndex}:none`,
    '-c:v', 'mjpeg',
    '-q:v', '5',
    '-vf', 'scale=1920:1080',
    '-f', 'mjpeg',
    '-r', '24000/1001',
    'pipe:1',
  ]);

  let pending = Buffer.alloc(0);

  let controllerClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      proc.stdout.on('data', (chunk: Buffer) => {
        if (controllerClosed) return;
        pending = Buffer.concat([pending, chunk]);

        // Extract complete JPEG frames (FF D8 ... FF D9) and wrap in multipart.
        // FF D9 is unambiguous in JPEG — compressed scan data uses byte stuffing
        // (FF 00) so a bare FF D9 is always the genuine EOI marker.
        while (true) {
          let start = -1;
          for (let i = 0; i < pending.length - 1; i++) {
            if (pending[i] === 0xFF && pending[i + 1] === 0xD8) { start = i; break; }
          }
          if (start === -1) { pending = Buffer.alloc(0); break; }

          let end = -1;
          for (let i = start + 2; i < pending.length - 1; i++) {
            if (pending[i] === 0xFF && pending[i + 1] === 0xD9) { end = i + 2; break; }
          }
          if (end === -1) {
            if (start > 0) pending = pending.subarray(start);
            break;
          }

          const frame = pending.subarray(start, end);
          const header = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
          controller.enqueue(Buffer.from(header));
          controller.enqueue(Buffer.from(frame));
          controller.enqueue(Buffer.from('\r\n'));
          pending = pending.subarray(end);
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        console.warn('[atem-liveview]', chunk.toString('utf8').trim());
      });
      proc.once('close', () => {
        if (!controllerClosed) { controllerClosed = true; try { controller.close(); } catch { /* ignore */ } }
      });
      proc.once('error', (err) => {
        console.error('[atem-liveview] spawn error:', err.message);
        if (!controllerClosed) { controllerClosed = true; try { controller.close(); } catch { /* ignore */ } }
      });
    },
    cancel() {
      controllerClosed = true;
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 2000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': `multipart/x-mixed-replace;boundary=${BOUNDARY}`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Accel-Buffering': 'no',
    },
  });
}
