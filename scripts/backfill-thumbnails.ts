/**
 * One-time backfill: generate thumbnails for all existing assets.
 * Run with: npx tsx scripts/backfill-thumbnails.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProjectStore } from '@/lib/services/container';
import { readRegistry } from '@/lib/store/media-registry';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { extractThumbnail } from '@/lib/services/media-probe';

async function main() {
  const projects = getProjectStore().getAll();
  console.log(`Found ${projects.length} project(s).`);

  let processed = 0, skipped = 0, failed = 0;

  for (const project of projects) {
    let mediaDir: string;
    try {
      mediaDir = resolveProjectMediaStorageDir(project.projectId);
    } catch {
      console.log(`  [${project.name}] no storage volume — skipped`);
      continue;
    }

    const assets = readRegistry(project.projectId);
    console.log(`\n[${project.name}] ${assets.length} asset(s)`);

    for (const asset of assets) {
      if (!asset.filePath || !fs.existsSync(asset.filePath)) {
        process.stdout.write('  · ' + asset.name + ' — no file, skipped\n');
        skipped++;
        continue;
      }

      const thumbPath = path.join(mediaDir, `${asset.assetId}.thumb.jpg`);
      if (fs.existsSync(thumbPath)) {
        process.stdout.write('  · ' + asset.name + ' — already exists, skipped\n');
        skipped++;
        continue;
      }

      process.stdout.write('  · ' + asset.name + ' … ');
      const ok = await extractThumbnail(asset.filePath, thumbPath);
      console.log(ok ? 'done' : 'failed');
      if (ok) processed++; else failed++;

      await new Promise((r) => setTimeout(r, 50));
    }
  }

  console.log(`\nDone. processed=${processed} skipped=${skipped} failed=${failed}`);
}

void main();
