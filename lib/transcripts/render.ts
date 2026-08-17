import fs from 'node:fs';
import path from 'node:path';

/**
 * Renderers for the derived transcript files.
 *
 * `<jobId>.json` (whisper segment JSON) is the CANONICAL transcript — it is the
 * only representation carrying per-segment timing. `.txt`, `.srt` and `.vtt` are
 * pure functions of it. Both producers of transcript text — the Spanish
 * translation pass and the manual transcript editor — regenerate the derived
 * trio through here, so an edit can never leave the four files disagreeing.
 */

export interface WhisperSegment {
  /** `HH:MM:SS,mmm` as whisper emits (comma milliseconds). */
  timestamps: { from: string; to: string };
  /** Millisecond offsets — what LP.AI and the cue editor use for arithmetic. */
  offsets: { from: number; to: number };
  /** Segment text. Whisper's convention is a single leading space. */
  text: string;
}

export interface WhisperJson {
  transcription: WhisperSegment[];
  [key: string]: unknown;
}

/** One segment per line, trimmed — matches whisper's own `.txt` output shape. */
export function buildTxt(segments: readonly WhisperSegment[]): string {
  return segments.map((seg) => seg.text.trim()).join('\n') + '\n';
}

/** SRT with whisper's comma-millisecond timestamps. */
export function buildSrt(segments: readonly WhisperSegment[]): string {
  return segments
    .map((seg, i) => `${i + 1}\n${seg.timestamps.from} --> ${seg.timestamps.to}\n${seg.text.trim()}\n`)
    .join('\n');
}

/** WebVTT with dot-millisecond timestamps (what Cloudflare Stream ingests). */
export function buildVtt(segments: readonly WhisperSegment[]): string {
  const cues = segments
    .map((seg) => {
      const from = seg.timestamps.from.replace(',', '.');
      const to = seg.timestamps.to.replace(',', '.');
      return `${from} --> ${to}`;
    })
    .map((cue, i) => `${cue}\n${segments[i].text.trim()}`)
    .join('\n\n');
  return `WEBVTT\n\n${cues}\n`;
}

/**
 * Write via a sibling temp file + rename so a reader (a publish flow pulling the
 * VTT, or Pass Prep reading the TXT) never observes a half-written transcript.
 */
export function writeFileAtomic(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, contents);
  fs.renameSync(tmpPath, filePath);
}

export interface DerivedTranscriptPaths {
  txtPath: string;
  srtPath: string;
  vttPath: string;
}

/** Regenerate `.txt`, `.srt` and `.vtt` from the canonical segments. */
export function writeDerivedTranscriptFiles(
  paths: DerivedTranscriptPaths,
  segments: readonly WhisperSegment[],
): void {
  writeFileAtomic(paths.txtPath, buildTxt(segments));
  writeFileAtomic(paths.srtPath, buildSrt(segments));
  writeFileAtomic(paths.vttPath, buildVtt(segments));
}
