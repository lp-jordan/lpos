/**
 * MediaProcessor
 *
 * Extracts audio from video using ffmpeg-static, then transcribes using
 * whisper.cpp using the LPOS-owned runtime contract.
 *
 * Runtime configuration:
 *   LPOS_WHISPER_BINARY      — explicit whisper.cpp executable path
 *   LPOS_WHISPER_RUNTIME_DIR — directory containing whisper runtime binaries
 *   LPOS_WHISPER_MODEL_DIR   — directory containing ggml-*.bin model files
 *   LPOS_WHISPER_MODEL       — model name without extension, default "base"
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import ffmpegPath from 'ffmpeg-static';
import { getWhisperModelDir, resolveWhisperBinaryPath } from './runtime-dependencies';
import { getTranscriptionModel } from './transcription-config';

export type ProcessorPhase =
  | 'queued'
  | 'extracting_audio'
  | 'transcribing'
  | 'writing_outputs'
  | 'done'
  | 'failed';

export interface ProcessorProgress {
  phase: ProcessorPhase;
  percent: number;
}

export interface ProcessorResult {
  txtPath?: string;
  srtPath?: string;
  vttPath?: string;
  jsonPath?: string;
  /** Word-level timing sidecar (whisper.cpp JSON, one entry per word). Additive; UI ignores it. */
  wordsPath?: string;
}

function resolveWhisperBinary(): string {
  return resolveWhisperBinaryPath() ?? '';
}

function resolveModelDir(): string {
  return getWhisperModelDir();
}

export class MediaProcessor extends EventEmitter {
  private aborted = false;
  private currentProc: ChildProcess | null = null;

  abort() {
    this.aborted = true;
    this.currentProc?.kill();
  }

  async process(job: {
    jobId: string;
    filePath: string;
    projectDir: string;
    model?: string;
    /** BCP-47-ish whisper language code (e.g. "es"). When set, passed as `-l <lang>`
     *  so whisper transcribes IN that language instead of auto-detecting. Undefined
     *  for the standard English pass — whisper auto-detects as before. */
    language?: string;
  }): Promise<ProcessorResult> {
    // Per-job override wins; otherwise resolve from admin Settings (falls back to
    // env var then "base"). Resolving here means every enqueue path picks up the
    // configured model without threading it through each call site.
    const model = job.model ?? getTranscriptionModel();
    const tmpWav = path.join(os.tmpdir(), `lpos-${job.jobId}.wav`);

    try {
      // ── Phase 1: Extract audio ──────────────────────────────────────
      this.emit('progress', { phase: 'extracting_audio', percent: 5 } satisfies ProcessorProgress);
      await this.extractAudio(job.filePath, tmpWav);
      if (this.aborted) throw new Error('Job canceled');

      // ── Phase 2: Transcribe ─────────────────────────────────────────
      this.emit('progress', { phase: 'transcribing', percent: 20 } satisfies ProcessorProgress);

      const transcriptsDir = path.join(job.projectDir, 'transcripts');
      const subtitlesDir   = path.join(job.projectDir, 'subtitles');
      fs.mkdirSync(transcriptsDir, { recursive: true });
      fs.mkdirSync(subtitlesDir,   { recursive: true });

      const outputPrefix = path.join(transcriptsDir, job.jobId);
      const raw = await this.runWhisper(tmpWav, outputPrefix, model, job.language);
      if (this.aborted) throw new Error('Job canceled');

      // ── Phase 3: Organise outputs ───────────────────────────────────
      this.emit('progress', { phase: 'writing_outputs', percent: 93 } satisfies ProcessorProgress);

      const result: ProcessorResult = {
        txtPath:   raw.txtPath,
        jsonPath:  raw.jsonPath,
        wordsPath: raw.wordsPath,
      };

      // Move SRT / VTT into the subtitles folder
      for (const key of ['srtPath', 'vttPath'] as const) {
        const src = raw[key];
        if (src && fs.existsSync(src)) {
          const dest = path.join(subtitlesDir, path.basename(src));
          fs.renameSync(src, dest);
          result[key] = dest;
        }
      }

      this.emit('progress', { phase: 'done', percent: 100 } satisfies ProcessorProgress);
      return result;

    } finally {
      try { if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav); } catch { /* ignore */ }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Translate common ffmpeg stderr messages into plain-English errors. */
  private static describeffmpegError(stderr: string, code: number | null): string {
    if (stderr.includes('moov atom not found')) {
      return 'The video file is incomplete or corrupted — the MP4 metadata block (moov atom) is missing. This usually means the upload was interrupted. Try re-uploading the original file.';
    }
    if (stderr.includes('Invalid data found when processing input')) {
      return 'The file could not be read — it may be corrupted or in an unsupported format.';
    }
    if (stderr.includes('No such file or directory')) {
      return 'The file could not be found at the recorded path. It may have been moved or deleted.';
    }
    if (stderr.includes('Permission denied')) {
      return 'Permission denied reading the file. Check that the LPOS service account has access to the media directory.';
    }
    if (stderr.includes('Invalid option') || stderr.includes('Unrecognized option')) {
      return 'An internal ffmpeg option was not recognised. Please report this to your LPOS administrator.';
    }
    return `Audio extraction failed (code ${code}).`;
  }

  private extractAudio(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!ffmpegPath) { reject(new Error('ffmpeg-static binary not found')); return; }

      const proc = spawn(ffmpegPath, [
        '-nostdin',
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y', outputPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      this.currentProc = proc;

      let stderrBuf = '';
      proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

      let pct = 5;
      const timer = setInterval(() => {
        pct = Math.min(pct + 2, 18);
        this.emit('progress', { phase: 'extracting_audio', percent: pct } satisfies ProcessorProgress);
      }, 500);

      proc.on('close', (code) => {
        this.currentProc = null;
        clearInterval(timer);
        if (this.aborted) { reject(new Error('Job canceled')); return; }
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(MediaProcessor.describeffmpegError(stderrBuf, code)));
        }
      });
      proc.on('error', (err) => { this.currentProc = null; clearInterval(timer); reject(err); });
    });
  }

  private async runWhisper(wavPath: string, outputPrefix: string, model: string, language?: string): Promise<ProcessorResult> {
    const whisperBin = resolveWhisperBinary();
    if (!whisperBin) {
      throw new Error(
        'Whisper runtime is not configured. Set LPOS_WHISPER_BINARY or stage files into runtime/whisper-runtime.'
      );
    }

    const modelDir  = resolveModelDir();
    const modelPath = path.join(modelDir, `ggml-${model}.bin`);
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Whisper model not found: ${modelPath}. Set LPOS_WHISPER_MODEL_DIR or stage files into runtime/whisper-models.`);
    }

    // When a language is requested, force it with `-l <lang>` so whisper
    // transcribes IN that language rather than auto-detecting (and never
    // translating — we deliberately omit `-tr`). Empty for the English pass,
    // preserving the auto-detect behavior the standard transcript relies on.
    const langArgs = language ? ['-l', language] : [];

    // ── Primary run — the outputs the Transcripts UI depends on. UNCHANGED. ──
    // Segment-level JSON (`-oj`) + txt/srt/vtt at the canonical `${jobId}.*`
    // prefix. These are enumerated by lib/transcripts/store.ts.
    await this.spawnWhisper(whisperBin, [
      '-m', modelPath,
      '-f', wavPath,
      ...langArgs,
      '-oj',   // output JSON (segment-level, ms offsets)
      '-otxt', // output plain text
      '-osrt', // output SRT subtitles
      '-ovtt', // output VTT subtitles
      '-of', outputPrefix,
    ], 20, 82);

    if (this.aborted) throw new Error('Job canceled');

    const result: ProcessorResult = {
      txtPath:  `${outputPrefix}.txt`,
      jsonPath: `${outputPrefix}.json`,
      srtPath:  `${outputPrefix}.srt`,
      vttPath:  `${outputPrefix}.vtt`,
    };

    // ── Additive word-level pass — writes a SEPARATE sidecar. ────────────────
    // Approach: `-ml 1 -sow` (max-len 1 char, split-on-word) makes whisper emit
    // one JSON segment per WORD, each with `offsets.{from,to}` in ms. Chosen over
    // `-ojf -dtw <model>` because -dtw requires a compiled alignment-heads preset
    // whose name must exactly match the model (base / large.v3 / large.v3.turbo);
    // a mismatch aborts the run. `-ml 1 -sow` is model-agnostic and reuses the
    // JSON shape the rest of the stack already understands. The tradeoff is
    // per-word timing is decode-derived (slightly looser than DTW), which is
    // acceptable for a downstream word-timecode feed.
    // Written to `${jobId}.words.json` — does NOT end with `.txt`/`.srt`/`.vtt`,
    // so store.ts's `.txt`-based enumeration never surfaces it. Best-effort:
    // a failure here must not fail the job, since the primary outputs succeeded.
    const wordsPrefix = `${outputPrefix}.words`;
    try {
      await this.spawnWhisper(whisperBin, [
        '-m', modelPath,
        '-f', wavPath,
        ...langArgs,
        '-ml', '1',   // max segment length: 1 character → one entry per word
        '-sow',       // split on word boundaries rather than tokens
        '-oj',        // JSON output (word-granular given -ml 1 -sow)
        '-of', wordsPrefix,
      ], 82, 92);
      const wordsJson = `${wordsPrefix}.json`;
      if (fs.existsSync(wordsJson)) result.wordsPath = wordsJson;
    } catch (e) {
      console.warn('[media-processor] word-level pass failed (primary transcript unaffected):', (e as Error).message);
    }

    return result;
  }

  /**
   * Spawn a single whisper.cpp invocation, emitting `transcribing` progress that
   * ramps between `pctFrom` and `pctTo`. Resolves on exit code 0, rejects otherwise.
   */
  private spawnWhisper(whisperBin: string, args: string[], pctFrom: number, pctTo: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(whisperBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.currentProc = proc;

      let stderrBuf = '';
      proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
      proc.stdout?.on('data', () => { /* suppress — whisper writes progress to stdout */ });

      let pct = pctFrom;
      const timer = setInterval(() => {
        pct = Math.min(pct + 1, pctTo);
        this.emit('progress', { phase: 'transcribing', percent: pct } satisfies ProcessorProgress);
      }, 2000);

      proc.on('close', (code, signal) => {
        this.currentProc = null;
        clearInterval(timer);
        if (this.aborted) { reject(new Error('Job canceled')); return; }
        if (code === 0) {
          resolve();
        } else {
          const reason = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
          const detail = stderrBuf.trim();
          reject(new Error(detail ? `whisper ${reason}\n${detail}` : `whisper ${reason}`));
        }
      });
      proc.on('error', (err) => { this.currentProc = null; clearInterval(timer); reject(err); });
    });
  }
}
