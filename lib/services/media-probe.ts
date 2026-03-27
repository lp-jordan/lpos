/**
 * Extracts media duration using ffmpeg-static.
 * Returns duration in seconds or null if extraction fails.
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

    proc.on('close', () => {
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

    proc.on('error', () => resolve(null));

    // Safety timeout — don't block uploads if ffmpeg hangs
    setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 15_000);
  });
}
