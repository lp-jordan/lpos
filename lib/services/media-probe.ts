/**
 * Extracts media duration and thumbnails using ffmpeg-static.
 */

import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

export function probeDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve(null); return; }

    const proc = spawn(ffmpegPath, ['-i', filePath, '-f', 'null', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // Safety timeout — don't block uploads if ffmpeg hangs
    const timeout = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 15_000);

    proc.on('close', () => {
      clearTimeout(timeout);
      // ffmpeg prints "Duration: HH:MM:SS.mm" in its stderr output
      const match = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr);
      if (!match) { resolve(null); return; }
      const hours = parseInt(match[1]!, 10);
      const minutes = parseInt(match[2]!, 10);
      const seconds = parseInt(match[3]!, 10);
      const centiseconds = parseInt(match[4]!, 10);
      const total = hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
      resolve(total > 0 ? total : null);
    });

    proc.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

/**
 * Extracts a single frame from a video at 0.5s and saves it as a JPEG.
 * Uses fast keyframe seek (-ss before -i) so it's nearly instant regardless of file size.
 * Returns true on success, false if ffmpeg is unavailable or the file has no video stream.
 */
export function extractThumbnail(filePath: string, outputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve(false); return; }

    const proc = spawn(ffmpegPath, [
      '-ss', '0.5',
      '-i', filePath,
      '-vframes', '1',
      '-vf', 'scale=320:-1',
      '-q:v', '5',
      '-y',
      outputPath,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    const timeout = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } resolve(false); }, 15_000);
    proc.on('close', (code) => { clearTimeout(timeout); resolve(code === 0); });
    proc.on('error', () => { clearTimeout(timeout); resolve(false); });
  });
}
