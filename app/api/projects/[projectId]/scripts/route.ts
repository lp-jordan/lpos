import { NextRequest, NextResponse } from 'next/server';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { Readable } from 'node:stream';
import Busboy from 'busboy';
import { getProjectStore } from '@/lib/services/container';
import {
  readScriptsRegistry,
  registerScript,
  patchScript,
  scriptsDir,
  guessMime,
} from '@/lib/store/scripts-registry';
import { extractAndSave } from '@/lib/services/script-extractor';

type Ctx = { params: Promise<{ projectId: string }> };

// ── GET — list all scripts ────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const scripts = readScriptsRegistry(projectId);
  return NextResponse.json({ scripts });
}

// ── POST — upload a script file ───────────────────────────────────────────────

export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const dir = scriptsDir(projectId);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(os.tmpdir(), `lpos-script-${Date.now()}`);

  try {
    const { originalFilename, fileSize, mimeType } = await streamToDisk(req, tmpPath, contentType);

    if (!originalFilename) {
      fs.unlinkSync(tmpPath);
      return NextResponse.json({ error: 'No file received' }, { status: 400 });
    }

    const ext = path.extname(originalFilename).toLowerCase();
    const allowed = new Set(['.docx', '.pdf', '.txt', '.doc']);
    if (!allowed.has(ext)) {
      fs.unlinkSync(tmpPath);
      return NextResponse.json({ error: 'Only .docx, .pdf, .txt, .doc files are accepted' }, { status: 400 });
    }

    // Register with a temp filePath first so we get a stable scriptId
    const script = registerScript({
      projectId,
      originalFilename,
      filePath: tmpPath,
      fileSize,
      mimeType,
    });

    // Move to final location and patch the registry with the real path
    const finalPath = path.join(dir, `${script.scriptId}${ext}`);
    fs.renameSync(tmpPath, finalPath);
    patchScript(projectId, script.scriptId, { filePath: finalPath });

    // Kick off extraction in background
    void extractAndSave(projectId, script.scriptId, finalPath, ext);

    return NextResponse.json({ script: { ...script, filePath: finalPath } }, { status: 201 });
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface StreamResult {
  originalFilename: string | null;
  fileSize: number | null;
  mimeType: string;
}

async function streamToDisk(req: NextRequest, dest: string, contentType: string): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: { 'content-type': contentType } });
    let originalFilename: string | null = null;
    let fileSize = 0;
    let detectedMime = 'application/octet-stream';
    let fileStream: fs.WriteStream | null = null;

    bb.on('file', (fieldname, stream, info) => {
      originalFilename = Buffer.from(info.filename, 'latin1').toString('utf8');
      detectedMime     = info.mimeType || guessMime(originalFilename);
      fileStream       = fs.createWriteStream(dest);
      stream.on('data', (chunk: Buffer) => { fileSize += chunk.length; });
      stream.pipe(fileStream);
    });

    bb.on('finish', () => {
      if (fileStream) {
        fileStream.end(() => resolve({ originalFilename, fileSize, mimeType: detectedMime }));
      } else {
        resolve({ originalFilename, fileSize, mimeType: detectedMime });
      }
    });

    bb.on('error', reject);

    const bodyBuffer = req.body;
    if (!bodyBuffer) { reject(new Error('Empty body')); return; }

    // Pipe ReadableStream → Node stream → Busboy
    const nodeStream = Readable.fromWeb(bodyBuffer as import('stream/web').ReadableStream);
    nodeStream.pipe(bb);
  });
}

