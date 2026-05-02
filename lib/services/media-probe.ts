/**
 * Extracts media duration and thumbnails using ffmpeg-static.
 */

import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

export interface MediaInfo {
  duration: number | null;
  fps: number | null;
}

function parseDuration(stderr: string): number | null {
  const match = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr);
  if (!match) return null;
  const total =
    parseInt(match[1]!, 10) * 3600 +
    parseInt(match[2]!, 10) * 60 +
    parseInt(match[3]!, 10) +
    parseInt(match[4]!, 10) / 100;
  return total > 0 ? total : null;
}

function parseFps(stderr: string): number | null {
  // ffmpeg prints e.g. "29.97 fps" or "25 fps" in the stream info line
  const match = /(\d+(?:\.\d+)?)\s*fps/.exec(stderr);
  if (match) {
    const val = parseFloat(match[1]!);
    return val > 0 ? val : null;
  }
  return null;
}

/**
 * Probes both duration and fps from the same fast ffmpeg metadata pass.
 * Uses -i without decoding output (-f null -) so it's near-instant.
 */
export function probeMediaInfo(filePath: string): Promise<MediaInfo> {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve({ duration: null, fps: null }); return; }

    const proc = spawn(ffmpegPath, ['-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timeout = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
    }, 10_000);

    proc.on('close', () => {
      clearTimeout(timeout);
      resolve({ duration: parseDuration(stderr), fps: parseFps(stderr) });
    });

    proc.on('error', () => { clearTimeout(timeout); resolve({ duration: null, fps: null }); });
  });
}

export function probeDuration(filePath: string): Promise<number | null> {
  return probeMediaInfo(filePath).then((info) => info.duration);
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
