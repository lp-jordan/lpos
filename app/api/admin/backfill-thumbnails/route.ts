/**
 * POST /api/admin/backfill-thumbnails
 *
 * Generates thumbnails for all existing assets that have an accessible local
 * file but no thumbnail JPEG yet. Processes sequentially with a small yield
 * between each asset so the event loop stays responsive during a large run.
 *
 * Idempotent — safe to re-run; already-thumbnailed assets are skipped.
 * Admin-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { readRegistry } from '@/lib/store/media-registry';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { extractThumbnail } from '@/lib/services/media-probe';

export async function POST(req: NextRequest) {
  const authError = await requireRole(req, 'admin');
  if (authError) return authError;

  const projects = getProjectStore().getAll();

  let processed = 0;
  let skipped   = 0;
  let failed    = 0;

  for (const project of projects) {
    let mediaDir: string;
    try {
      mediaDir = resolveProjectMediaStorageDir(project.projectId);
    } catch {
      // No eligible storage volume for this project — skip entirely
      continue;
    }

    const assets = readRegistry(project.projectId);

    for (const asset of assets) {
      // Skip assets with no accessible file
      if (!asset.filePath || !fs.existsSync(asset.filePath)) {
        skipped++;
        continue;
      }

      const thumbPath = path.join(mediaDir, `${asset.assetId}.thumb.jpg`);

      // Already have a thumbnail — skip
      if (fs.existsSync(thumbPath)) {
        skipped++;
        continue;
      }

      const ok = await extractThumbnail(asset.filePath, thumbPath);
      if (ok) processed++; else failed++;

      // Yield to the event loop between each extraction so ingest/other
      // requests aren't starved during a large backfill run.
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return NextResponse.json({ ok: true, processed, skipped, failed });
}
