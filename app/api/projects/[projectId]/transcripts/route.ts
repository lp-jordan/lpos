import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { readRegistry } from '@/lib/store/media-registry';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

export interface TranscriptEntry {
  jobId: string;
  filename: string;    // original media filename (from meta) or jobId fallback
  completedAt: string;
  txtSize: number;
  files: { txt: boolean; json: boolean; srt: boolean; vtt: boolean };
}

// ── GET — list completed transcripts for a project ─────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const transcriptsDir = path.join(DATA_DIR, 'projects', projectId, 'transcripts');
  const subtitlesDir   = path.join(DATA_DIR, 'projects', projectId, 'subtitles');

  // Optional: serve a file directly via ?download=jobId&type=txt|json|srt|vtt
  const { searchParams } = new URL(req.url);
  const download = searchParams.get('download');
  const type     = searchParams.get('type');

  if (download && type) {
    const dir = (type === 'srt' || type === 'vtt') ? subtitlesDir : transcriptsDir;
    const filePath = path.join(dir, `${download}.${type}`);
    if (!fs.existsSync(filePath)) return NextResponse.json({ error: 'File not found' }, { status: 404 });
    const content = fs.readFileSync(filePath);
    const mimeTypes: Record<string, string> = {
      txt:  'text/plain',
      json: 'application/json',
      srt:  'text/plain',
      vtt:  'text/vtt',
    };
    return new NextResponse(content, {
      headers: {
        'Content-Type': mimeTypes[type] ?? 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${download}.${type}"`,
      },
    });
  }

  // List all transcripts
  if (!fs.existsSync(transcriptsDir)) return NextResponse.json({ transcripts: [] });

  // Build assetId → originalFilename lookup from media registry
  const assetNameMap = new Map<string, string>();
  try {
    const assets = readRegistry(projectId);
    for (const a of assets) assetNameMap.set(a.assetId, a.originalFilename ?? a.name);
  } catch { /* ignore if registry missing */ }

  // UUID-shaped filename pattern (e.g. the stable {assetId}.mp4 name we used to store)
  const UUID_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[^.]+$/i;

  // Find all .txt files (one per job) to enumerate completed transcripts
  const txtFiles = fs.readdirSync(transcriptsDir)
    .filter((f) => f.endsWith('.txt') && !f.endsWith('.meta.json'));

  const transcripts: TranscriptEntry[] = txtFiles.map((txtName) => {
    const jobId   = path.basename(txtName, '.txt');
    const txtPath = path.join(transcriptsDir, txtName);
    const stat    = fs.statSync(txtPath);

    // Read meta sidecar if present
    let filename    = jobId;
    let completedAt = stat.mtime.toISOString();
    let metaAssetId: string | undefined;
    const metaPath  = path.join(transcriptsDir, `${jobId}.meta.json`);
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
          filename?: string; completedAt?: string; assetId?: string;
        };
        if (meta.filename)    filename    = meta.filename;
        if (meta.completedAt) completedAt = meta.completedAt;
        if (meta.assetId)     metaAssetId = meta.assetId;
      }
    } catch { /* ignore */ }

    // If filename is still a raw UUID-based name, resolve via media registry
    if (UUID_FILE_RE.test(filename) && metaAssetId) {
      const resolved = assetNameMap.get(metaAssetId);
      if (resolved) filename = resolved;
    }

    return {
      jobId,
      filename,
      completedAt,
      txtSize: stat.size,
      files: {
        txt:  true,
        json: fs.existsSync(path.join(transcriptsDir, `${jobId}.json`)),
        srt:  fs.existsSync(path.join(subtitlesDir,   `${jobId}.srt`)),
        vtt:  fs.existsSync(path.join(subtitlesDir,   `${jobId}.vtt`)),
      },
    };
  });

  // Newest first
  transcripts.sort((a, b) => b.completedAt.localeCompare(a.completedAt));

  return NextResponse.json({ transcripts });
}
