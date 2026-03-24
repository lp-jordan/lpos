/**
 * frameio-compress.ts
 *
 * Silently re-encodes large video files to H.264 before Frame.io upload.
 * Used automatically when a file exceeds Frame.io's 2 GiB per-file limit.
 *
 * Output is a review-quality proxy (CRF 23, veryfast preset) — good enough
 * for frame-accurate review on Frame.io, typically 60-80% smaller than
 * source ProRes/h265 material.
 *
 * The original NAS file is never modified.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs             from 'node:fs';
import path           from 'node:path';
import os             from 'node:os';
import ffmpegPath     from 'ffmpeg-static';

// Track active ffmpeg processes by upload jobId so they can be killed on cancel
const activeProcs = new Map<string, ChildProcess>();

/** Kill the ffmpeg process for a given upload job (called on cancel). */
export function cancelCompress(jobId: string): void {
  const proc = activeProcs.get(jobId);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    activeProcs.delete(jobId);
  }
}

/** Files at or above this size are compressed before upload. */
export const COMPRESS_THRESHOLD_BYTES = 1_900_000_000; // 1.9 GB

/** Progress callback: 0-100, plus a phase label. */
export type CompressProgressCallback = (percent: number) => void;

// ── Duration probe ─────────────────────────────────────────────────────────

/** Quick probe: run `ffmpeg -i file` (exits 1) and parse Duration from stderr. */
function probeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve(0); return; }
    const proc = spawn(ffmpegPath, ['-i', filePath]);
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) {
        resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]));
      } else {
        resolve(0);
      }
    });
    proc.on('error', () => resolve(0));
  });
}

// ── Main compress function ─────────────────────────────────────────────────

export interface CompressResult {
  outputPath: string;   // path to the compressed file (temp file — caller must clean up)
  compressed: true;
}

/**
 * Compress a video file to a review-quality H.264 proxy.
 * Returns the path to the output file.
 * @param onProgress called with 0-100 as encoding progresses
 */
export async function compressForFrameIO(
  inputPath: string,
  onProgress: CompressProgressCallback,
  jobId?: string,
): Promise<CompressResult> {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not found');

  // Output lands in the OS temp dir so it doesn't pollute the NAS
  const ext        = path.extname(inputPath) || '.mp4';
  const outputPath = path.join(
    os.tmpdir(),
    `lpos-fio-proxy-${Date.now()}${ext}`,
  );

  // Probe total duration so we can report real percentage
  const totalSecs = await probeDurationSeconds(inputPath);

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-i',  inputPath,
      // Video: H.264 CRF 23, veryfast — good review quality, ~3-5× realtime
      '-c:v', 'libx264',
      '-crf', '23',
      '-preset', 'veryfast',
      // Audio: AAC 128 kbps — fine for speech/music review
      '-c:a', 'aac',
      '-b:a', '128k',
      // moov atom first → better streaming on Frame.io
      '-movflags', '+faststart',
      // Machine-readable progress to stdout
      '-progress', 'pipe:1',
      '-nostats',
      '-y',
      outputPath,
    ];

    const proc = spawn(ffmpegPath!, args);
    if (jobId) activeProcs.set(jobId, proc);

    // Parse -progress pipe:1 output (stdout) for out_time_ms
    let stdoutBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';

      for (const line of lines) {
        const m = line.match(/^out_time_ms=(\d+)/);
        if (m && totalSecs > 0) {
          const elapsedSecs = parseInt(m[1]) / 1_000_000;
          const pct = Math.min(99, Math.round((elapsedSecs / totalSecs) * 100));
          onProgress(pct);
        }
      }
    });

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    proc.on('close', (code) => {
      if (jobId) activeProcs.delete(jobId);
      if (code === 0) {
        onProgress(100);
        resolve();
      } else {
        // Clean up partial output
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* ignore */ }
        // SIGTERM from cancel() produces code null or 143 — surface as Cancelled
        const wasCancelled = code === null || code === 143;
        reject(new Error(wasCancelled ? 'Cancelled' : `ffmpeg compression exited with code ${code}: ${stderrBuf.slice(-400)}`));
      }
    });

    proc.on('error', (err) => {
      if (jobId) activeProcs.delete(jobId);
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* ignore */ }
      reject(err);
    });
  });

  return { outputPath, compressed: true };
}
