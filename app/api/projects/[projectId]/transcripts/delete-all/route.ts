import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectById } from '@/lib/selectors/projects';
import { getTranscriptPaths } from '@/lib/transcripts/store';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!getProjectById(projectId)) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const transcriptsDir = path.join(DATA_DIR, 'projects', projectId, 'transcripts');
  if (!fs.existsSync(transcriptsDir)) return NextResponse.json({ deleted: 0 });

  const metaFiles = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.meta.json'));
  let deleted = 0;

  for (const metaFile of metaFiles) {
    const jobId = metaFile.replace(/\.meta\.json$/, '');
    const { txtPath, jsonPath, srtPath, vttPath, metaPath } = getTranscriptPaths(projectId, jobId);
    for (const filePath of [txtPath, jsonPath, metaPath, srtPath, vttPath]) {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    }
    deleted++;
  }

  return NextResponse.json({ deleted });
}
