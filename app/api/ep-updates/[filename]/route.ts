/**
 * GET /api/ep-updates/[filename]
 *
 * Streams a file from the current EditPanel release directory.
 * Used to serve the .exe and latest.yml to editpanel clients / the download page.
 * No session required — the .exe / .yml are public via middleware's extension rule.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs   from 'node:fs';
import path from 'node:path';
import { getEpReleaseService } from '@/lib/services/container';

type Ctx = { params: Promise<{ filename: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { filename } = await params;

  // Prevent path traversal
  if (filename.includes('..') || filename.includes('/')) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }

  const svc = getEpReleaseService();
  if (!svc) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });

  const filePath = path.join(svc.getCurrentDir(), filename);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);
  const ext    = path.extname(filename).toLowerCase();
  const mime   = ext === '.exe'  ? 'application/octet-stream'
               : ext === '.yml'  ? 'text/yaml'
               : 'application/octet-stream';

  return new NextResponse(buffer, {
    headers: {
      'Content-Type':        mime,
      'Content-Length':      String(buffer.length),
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
