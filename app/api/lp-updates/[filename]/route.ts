/**
 * GET /api/lp-updates/[filename]
 *
 * Streams a file from the current release directory.
 * Used to serve the .dmg and latest-mac.yml to LP clients / download page.
 * No auth required — LP clients download without a session cookie.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs   from 'node:fs';
import path from 'node:path';
import { getLpReleaseService } from '@/lib/services/container';

type Ctx = { params: Promise<{ filename: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { filename } = await params;

  // Prevent path traversal
  if (filename.includes('..') || filename.includes('/')) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }

  const svc = getLpReleaseService();
  if (!svc) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });

  const filePath = path.join(svc.getCurrentDir(), filename);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);
  const ext    = path.extname(filename).toLowerCase();
  const mime   = ext === '.dmg'  ? 'application/x-apple-diskimage'
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
