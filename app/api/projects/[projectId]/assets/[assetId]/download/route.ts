/**
 * GET /api/projects/[projectId]/assets/[assetId]/download
 *
 * Proxies the file download through LPOS so editors don't need personal
 * Google Drive access to retrieve team assets.
 * Handles both Drive-backed and locally-stored (source='local') assets.
 */

import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getDriveAssetsByProject } from '@/lib/store/drive-sync-db';
import { downloadFile } from '@/lib/services/drive-client';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId, assetId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const all   = getDriveAssetsByProject(projectId);
  const asset = all.find((a) => a.entityId === assetId && a.entityType === 'asset' && !a.isFolder);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  try {
    let buffer: Buffer;
    if (asset.source === 'local') {
      if (!asset.localPath) {
        return NextResponse.json({ error: 'Local file path not recorded' }, { status: 500 });
      }
      if (!fs.existsSync(asset.localPath)) {
        return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
      }
      buffer = fs.readFileSync(asset.localPath);
    } else {
      buffer = await downloadFile(asset.driveFileId);
    }

    const mime = asset.mimeType ?? 'application/octet-stream';
    const name = encodeURIComponent(asset.name);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type':        mime,
        'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
        'Content-Length':      String(buffer.length),
      },
    });
  } catch (err) {
    console.error('[assets/download] error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
