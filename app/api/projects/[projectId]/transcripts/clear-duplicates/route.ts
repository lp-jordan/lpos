import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectById } from '@/lib/selectors/projects';
import { getTranscriptPaths } from '@/lib/transcripts/store';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

interface TranscriptMeta {
  jobId: string;
  assetId?: string;
  completedAt?: string;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!getProjectById(projectId)) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const transcriptsDir = path.join(DATA_DIR, 'projects', projectId, 'transcripts');
  if (!fs.existsSync(transcriptsDir)) return NextResponse.json({ cleared: 0 });

  // Read all meta files and group by assetId
  const metaFiles = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.meta.json'));
  const byAsset = new Map<string, TranscriptMeta[]>();

  for (const metaFile of metaFiles) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(transcriptsDir, metaFile), 'utf8')) as TranscriptMeta;
      const key = meta.assetId ?? meta.jobId; // fall back to jobId if no assetId (legacy)
      const existing = byAsset.get(key) ?? [];
      existing.push(meta);
      byAsset.set(key, existing);
    } catch {
      // Unreadable meta — skip
    }
  }

  let cleared = 0;

  for (const entries of byAsset.values()) {
    if (entries.length <= 1) continue;

    // Keep the most recent by completedAt; delete the rest
    entries.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
    const toDelete = entries.slice(1);

    for (const entry of toDelete) {
      const { txtPath, jsonPath, srtPath, vttPath, metaPath } = getTranscriptPaths(projectId, entry.jobId);
      for (const filePath of [txtPath, jsonPath, metaPath]) {
        try { fs.unlinkSync(filePath); } catch { /* already gone */ }
      }
      for (const filePath of [srtPath, vttPath]) {
        try { fs.unlinkSync(filePath); } catch { /* already gone */ }
      }
      console.log(`[transcripts] cleared duplicate ${entry.jobId} (asset ${entry.assetId ?? 'unknown'})`);
      cleared++;
    }
  }

  return NextResponse.json({ cleared });
}
