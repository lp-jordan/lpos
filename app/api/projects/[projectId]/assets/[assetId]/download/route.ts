/**
 * GET /api/projects/[projectId]/assets/[assetId]/download
 *
 * Proxies the file download through LPOS so editors don't need personal
 * Google Drive access to retrieve team assets.
 * Handles both Drive-backed and locally-stored (source='local') assets.
 *
 * Streams the response — never buffers the full file in memory — so large
 * assets don't block the Node.js event loop for other users.
 */

import fs   from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getDriveAssetsByProject } from '@/lib/store/drive-sync-db';
import { downloadFileStream } from '@/lib/services/drive-client';

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

  const mime = asset.mimeType ?? 'application/octet-stream';
  const name = encodeURIComponent(asset.name);
  const disposition = `attachment; filename*=UTF-8''${name}`;

  try {
    if (asset.source === 'local') {
      if (!asset.localPath) {
        return NextResponse.json({ error: 'Local file path not recorded' }, { status: 500 });
      }
      if (!fs.existsSync(asset.localPath)) {
        return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
      }
      const size   = fs.statSync(asset.localPath).size;
      const stream = fs.createReadStream(asset.localPath);
      return new NextResponse(stream as unknown as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type':        mime,
          'Content-Disposition': disposition,
          'Content-Length':      String(size),
        },
      });
    }

    // Drive-backed asset — stream directly from Google Drive without buffering
    const stream = await downloadFileStream(asset.driveFileId);
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type':        mime,
        'Content-Disposition': disposition,
        // No Content-Length — Drive doesn't expose it before the stream starts;
        // the browser will show a spinner and save correctly via chunked transfer.
      },
    });
  } catch (err) {
    console.error('[assets/download] error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
