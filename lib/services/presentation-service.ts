import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Server as SocketIOServer } from 'socket.io';

// Resolve the pdfjs worker file URL — needed so pdfjs can spawn its worker thread in Node.js.
// Use a direct path.resolve from cwd (the project root) — reliable in both dev and prod.
const PDFJS_WORKER_PATH = path.resolve(
  process.cwd(),
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
);
const PDFJS_WORKER_URL = `file:///${PDFJS_WORKER_PATH.replace(/\\/g, '/')}`;

// ── Temp directory ────────────────────────────────────────────────────────────

export const PRESENTATION_TEMP_DIR = path.join(os.tmpdir(), 'lpos-presentation');

// ── LibreOffice resolution ────────────────────────────────────────────────────

const LIBREOFFICE_WIN_PATHS = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
];

export function resolveLibreOfficeBinary(): string | null {
  if (process.platform === 'win32') {
    for (const candidate of LIBREOFFICE_WIN_PATHS) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  // Linux/macOS: rely on PATH
  return 'libreoffice';
}

// ── Conversion helpers ────────────────────────────────────────────────────────

function runLibreOffice(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args);
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`LibreOffice exited ${code}: ${stderr.trim() || '(no output)'}`));
      } else {
        resolve();
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`Failed to launch LibreOffice: ${err.message}`));
    });
  });
}

/** Render each page of a PDF to a PNG file using pdfjs-dist + @napi-rs/canvas. */
async function pdfToImages(pdfPath: string, outDir: string): Promise<string[]> {
  // @napi-rs/canvas provides DOMMatrix and ImageData which pdfjs expects globally
  const { createCanvas, DOMMatrix, ImageData } = await import('@napi-rs/canvas');
  if (!('DOMMatrix' in globalThis)) Object.assign(globalThis, { DOMMatrix });
  if (!('ImageData' in globalThis)) Object.assign(globalThis, { ImageData });

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  (pdfjsLib.GlobalWorkerOptions as { workerSrc: string }).workerSrc = PDFJS_WORKER_URL;

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;

  const paths: string[] = [];
  // 3.0× the PDF's 72-DPI base ≈ 216 DPI — presentation-quality output
  const SCALE = 3.0;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext('2d');

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    const buffer = canvas.toBuffer('image/png');
    const outPath = path.join(outDir, `slide-${String(i).padStart(4, '0')}.png`);
    fs.writeFileSync(outPath, buffer);
    paths.push(outPath);
    page.cleanup();
  }

  await doc.destroy();
  return paths;
}

// ── Public conversion entry points ────────────────────────────────────────────

/** Render a PDF directly to PNGs — no LibreOffice needed. */
export async function convertPdfToImages(pdfPath: string, outDir: string): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  return pdfToImages(pdfPath, outDir);
}

const WRITER_EXTS  = new Set(['.doc', '.docx', '.odt', '.rtf']);
const CALC_EXTS    = new Set(['.xls', '.xlsx', '.ods']);
const IMPRESS_EXTS = new Set(['.ppt', '.pptx', '.odp']);

function officeFilter(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (CALC_EXTS.has(ext))    return 'calc_pdf_Export';
  if (IMPRESS_EXTS.has(ext)) return 'impress_pdf_Export:EmbedStandardFonts=true,IsSkipEmptyPages=false';
  if (WRITER_EXTS.has(ext))  return 'writer_pdf_Export';
  return 'writer_pdf_Export'; // sensible fallback
}

/**
 * Convert any supported Office document (DOCX, XLSX, PPTX, DOC, XLS, PPT,
 * ODT, ODS, ODP, RTF) to PDF using the appropriate LibreOffice export filter.
 * Returns the path of the generated PDF inside outDir.
 */
export async function convertOfficeToPdf(officePath: string, outDir: string): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });

  const binary = resolveLibreOfficeBinary();
  if (!binary) {
    throw new Error(
      'LibreOffice not found. Install LibreOffice and ensure soffice.exe is at the default path.',
    );
  }

  const filter = officeFilter(officePath);

  await runLibreOffice(binary, [
    '--headless',
    '--convert-to', `pdf:${filter}`,
    '--outdir', outDir,
    officePath,
  ]);

  const pdfFiles = fs.readdirSync(outDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
  if (pdfFiles.length === 0) {
    throw new Error('LibreOffice did not produce a PDF — check that the file is a valid Office document.');
  }
  return path.join(outDir, pdfFiles[0]);
}

/** @deprecated Use convertOfficeToPdf */
export const convertDocxToPdf = convertOfficeToPdf;

export async function convertPptxToImages(pptxPath: string, outDir: string): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });

  const binary = resolveLibreOfficeBinary();
  if (!binary) {
    throw new Error(
      'LibreOffice not found. Install LibreOffice and ensure soffice.exe is at the default path.',
    );
  }

  // Step 1: PPTX → PDF. Use the impress PDF export filter with font embedding for best fidelity.
  await runLibreOffice(binary, [
    '--headless',
    '--convert-to', 'pdf:impress_pdf_Export:EmbedStandardFonts=true,IsSkipEmptyPages=false',
    '--outdir', outDir,
    pptxPath,
  ]);

  const pdfFiles = fs.readdirSync(outDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
  if (pdfFiles.length === 0) {
    throw new Error('LibreOffice did not produce a PDF — check that the file is a valid PPTX.');
  }
  const pdfPath = path.join(outDir, pdfFiles[0]);

  // Step 2: PDF → one PNG per page via pdfjs-dist + @napi-rs/canvas
  const slides = await pdfToImages(pdfPath, outDir);

  // Clean up intermediate PDF
  try { fs.unlinkSync(pdfPath); } catch { /* ignore */ }

  return slides;
}

// ── State ─────────────────────────────────────────────────────────────────────

export interface PresentationState {
  loaded: boolean;
  name: string;
  currentSlide: number;
  totalSlides: number;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class PresentationService {
  private io: SocketIOServer;
  private slides: string[] = [];
  private currentSlide = 0;
  private name = '';

  constructor(io: SocketIOServer) {
    this.io = io;
    this.setupNamespace();
  }

  private setupNamespace() {
    const ns = this.io.of('/presentation');

    ns.on('connection', (socket) => {
      // Send current state immediately to the connecting client
      socket.emit('presentation:state', this.getState());

      socket.on('presentation:slideChange', (data: { index: number }) => {
        const idx = data?.index;
        if (typeof idx !== 'number' || idx < 0 || idx >= this.slides.length) return;
        this.currentSlide = idx;
        // Broadcast to all clients (including sender) so every view stays in sync
        ns.emit('presentation:state', this.getState());
      });

      socket.on('presentation:clear', () => {
        this.clear();
        ns.emit('presentation:state', this.getState());
      });
    });
  }

  /** Called by the upload route after conversion completes. */
  loadPresentation(name: string, slidePaths: string[]) {
    this.clearFiles(); // clean up any previous temp files
    this.name = name;
    this.slides = slidePaths;
    this.currentSlide = 0;
    this.io.of('/presentation').emit('presentation:state', this.getState());
  }

  getState(): PresentationState {
    return {
      loaded: this.slides.length > 0,
      name: this.name,
      currentSlide: this.currentSlide,
      totalSlides: this.slides.length,
    };
  }

  /** Returns the absolute path to a slide PNG, or null if out of range. */
  getSlide(index: number): string | null {
    return this.slides[index] ?? null;
  }

  private clearFiles() {
    for (const slide of this.slides) {
      try { fs.unlinkSync(slide); } catch { /* ignore */ }
    }
    // Also try to remove the parent directory (upload-specific subdir)
    if (this.slides.length > 0) {
      try { fs.rmdirSync(path.dirname(this.slides[0])); } catch { /* ignore */ }
    }
  }

  private clear() {
    this.clearFiles();
    this.slides = [];
    this.currentSlide = 0;
    this.name = '';
  }
}
