import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

type VideoDevice = { index: string; label: string };

export async function GET() {
  if (!ffmpegPath) {
    return NextResponse.json({ error: 'ffmpeg not available' }, { status: 503 });
  }

  return new Promise<Response>((resolve) => {
    const proc = spawn(ffmpegPath!, [
      '-hide_banner',
      '-f', 'avfoundation',
      '-list_devices', 'true',
      '-i', '',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    let done = false;

    const finish = (devices: VideoDevice[]) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(NextResponse.json({ devices }));
    };

    const timeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
      finish([]);
    }, 5000);

    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    proc.once('close', () => {
      // avfoundation lists video devices first, then audio. Split on the audio
      // section header so we only match video device lines.
      const videoSection = stderr.split(/AVFoundation audio devices:/i)[0] ?? stderr;
      const devices: VideoDevice[] = [...videoSection.matchAll(/\[(\d+)\]\s+(.+)$/gm)].map((m) => ({
        index: m[1],
        label: m[2].trim(),
      }));
      finish(devices);
    });

    proc.once('error', () => finish([]));
  });
}
