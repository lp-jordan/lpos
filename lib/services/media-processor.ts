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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import ffmpegPath from 'ffmpeg-static';
import { getWhisperModelDir, resolveWhisperBinaryPath } from './runtime-dependencies';

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
}

function resolveWhisperBinary(): string {
  return resolveWhisperBinaryPath() ?? '';
}

function resolveModelDir(): string {
  return getWhisperModelDir();
}

export class MediaProcessor extends EventEmitter {
  private aborted = false;

  abort() { this.aborted = true; }

  async process(job: {
    jobId: string;
    filePath: string;
    projectDir: string;
    model?: string;
  }): Promise<ProcessorResult> {
    const model = job.model ?? process.env.LPOS_WHISPER_MODEL ?? 'base';
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
      const raw = await this.runWhisper(tmpWav, outputPrefix, model);
      if (this.aborted) throw new Error('Job canceled');

      // ── Phase 3: Organise outputs ───────────────────────────────────
      this.emit('progress', { phase: 'writing_outputs', percent: 93 } satisfies ProcessorProgress);

      const result: ProcessorResult = { txtPath: raw.txtPath, jsonPath: raw.jsonPath };

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

  private extractAudio(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!ffmpegPath) { reject(new Error('ffmpeg-static binary not found')); return; }

      const proc = spawn(ffmpegPath, [
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y', outputPath,
      ]);

      let pct = 5;
      const timer = setInterval(() => {
        pct = Math.min(pct + 2, 18);
        this.emit('progress', { phase: 'extracting_audio', percent: pct } satisfies ProcessorProgress);
      }, 500);

      proc.on('close', (code) => {
        clearInterval(timer);
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`));
      });
      proc.on('error', (err) => { clearInterval(timer); reject(err); });
    });
  }

  private runWhisper(wavPath: string, outputPrefix: string, model: string): Promise<ProcessorResult> {
    return new Promise((resolve, reject) => {
      const whisperBin = resolveWhisperBinary();
      if (!whisperBin) {
        reject(new Error(
          'Whisper runtime is not configured. Set LPOS_WHISPER_BINARY or stage files into runtime/whisper-runtime.'
        ));
        return;
      }

      const modelDir  = resolveModelDir();
      const modelPath = path.join(modelDir, `ggml-${model}.bin`);
      if (!fs.existsSync(modelPath)) {
        reject(new Error(`Whisper model not found: ${modelPath}. Set LPOS_WHISPER_MODEL_DIR or stage files into runtime/whisper-models.`));
        return;
      }

      const proc = spawn(whisperBin, [
        '-m', modelPath,
        '-f', wavPath,
        '-oj',   // output JSON
        '-otxt', // output plain text
        '-osrt', // output SRT subtitles
        '-ovtt', // output VTT subtitles
        '-of', outputPrefix,
      ]);

      let pct = 20;
      const timer = setInterval(() => {
        pct = Math.min(pct + 1, 88);
        this.emit('progress', { phase: 'transcribing', percent: pct } satisfies ProcessorProgress);
      }, 2000);

      proc.on('close', (code) => {
        clearInterval(timer);
        if (code === 0) {
          resolve({
            txtPath:  `${outputPrefix}.txt`,
            jsonPath: `${outputPrefix}.json`,
            srtPath:  `${outputPrefix}.srt`,
            vttPath:  `${outputPrefix}.vtt`,
          });
        } else {
          reject(new Error(`whisper exited with code ${code}`));
        }
      });
      proc.on('error', (err) => { clearInterval(timer); reject(err); });
    });
  }
}
