import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'node:child_process';
import path from 'node:path';
import { getAsset } from '@/lib/store/media-registry';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function POST(_req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, assetId } = await params;
    const asset = getAsset(projectId, assetId);
    if (!asset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!asset.filePath) return NextResponse.json({ error: 'No file path recorded for this asset' }, { status: 400 });

    const filePath = path.normalize(asset.filePath);

    // Open the containing folder and select the file
    const platform = process.platform;
    if (platform === 'win32') {
      exec(`explorer /select,"${filePath}"`);
    } else if (platform === 'darwin') {
      exec(`open -R "${filePath}"`);
    } else {
      exec(`xdg-open "${path.dirname(filePath)}"`);
    }

    return NextResponse.json({ ok: true, filePath });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
