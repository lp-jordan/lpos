/**
 * POST /api/projects/[projectId]/assets/download-zip
 *
 * Batch-download the selected project assets as a single .zip.
 * Accepts a mix of files and folders; selected folders are recursed and their
 * contents added with the folder structure preserved inside the archive.
 *
 * Body: { entityIds: string[]; zipName?: string }
 *
 * Handles both Drive-backed and locally-stored (source='local') assets. The zip
 * is streamed — files are never all buffered in memory at once — so large
 * batches don't block the event loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import archiver from 'archiver';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getDriveAssetsByProject, type DriveAsset } from '@/lib/store/drive-sync-db';
import { downloadFileStream } from '@/lib/services/drive-client';

type Ctx = { params: Promise<{ projectId: string }> };

/** Sanitise a single path segment so it can't escape or nest unexpectedly. */
function safeSegment(name: string): string {
  const cleaned = Array.from(name || '')
    .filter((ch) => ch.charCodeAt(0) >= 0x20)   // drop control characters
    .join('')
    .replace(/[/\\]/g, '_')
    .trim();
  return cleaned || 'file';
}

/** Ensure every zip entry path is unique; suffix "(n)" before the extension on collision. */
function uniquePath(used: Set<string>, entryPath: string): string {
  if (!used.has(entryPath)) { used.add(entryPath); return entryPath; }
  const dir  = path.posix.dirname(entryPath);
  const base = path.posix.basename(entryPath);
  const ext  = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let i = 1;
  let candidate: string;
  do {
    const name = `${stem} (${i})${ext}`;
    candidate = dir === '.' ? name : `${dir}/${name}`;
    i += 1;
  } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const body = await req.json().catch(() => null) as { entityIds?: string[]; zipName?: string } | null;
  if (!body || !Array.isArray(body.entityIds) || body.entityIds.length === 0) {
    return NextResponse.json({ error: 'entityIds (non-empty array) is required' }, { status: 400 });
  }

  const all = getDriveAssetsByProject(projectId).filter((a) => a.entityType === 'asset');
  const byEntityId = new Map(all.map((a) => [a.entityId, a]));
  const childrenByParent = new Map<string, DriveAsset[]>();
  for (const a of all) {
    if (!a.parentDriveId) continue;
    const list = childrenByParent.get(a.parentDriveId) ?? [];
    list.push(a);
    childrenByParent.set(a.parentDriveId, list);
  }

  // Flatten the selection into { asset, path } file entries, recursing folders.
  const entries: { asset: DriveAsset; entryPath: string }[] = [];
  const seen = new Set<string>(); // entityIds already added — avoid dupes when a folder + its child are both selected

  function addFolder(folder: DriveAsset, prefix: string) {
    for (const child of childrenByParent.get(folder.driveFileId) ?? []) {
      const childPath = `${prefix}/${safeSegment(child.name)}`;
      if (child.isFolder) {
        addFolder(child, childPath);
      } else if (!seen.has(child.entityId)) {
        seen.add(child.entityId);
        entries.push({ asset: child, entryPath: childPath });
      }
    }
  }

  for (const id of body.entityIds) {
    const asset = byEntityId.get(id);
    if (!asset) continue;
    if (asset.isFolder) {
      addFolder(asset, safeSegment(asset.name));
    } else if (!seen.has(asset.entityId)) {
      seen.add(asset.entityId);
      entries.push({ asset, entryPath: safeSegment(asset.name) });
    }
  }

  if (entries.length === 0) {
    return NextResponse.json({ error: 'No downloadable files in selection' }, { status: 404 });
  }

  const passthrough = new PassThrough();
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => passthrough.destroy(err));
  archive.pipe(passthrough);

  // Build the archive asynchronously so the response can start streaming immediately.
  void (async () => {
    const usedPaths = new Set<string>();
    try {
      for (const { asset, entryPath } of entries) {
        // Google Workspace native docs can't be binary-downloaded via alt=media — skip.
        if (asset.mimeType?.startsWith('application/vnd.google-apps.')) continue;
        const name = uniquePath(usedPaths, entryPath);
        try {
          if (asset.source === 'local') {
            if (asset.localPath && fs.existsSync(asset.localPath)) {
              archive.file(asset.localPath, { name });
            }
          } else {
            const stream = await downloadFileStream(asset.driveFileId);
            archive.append(stream as unknown as Readable, { name });
          }
        } catch (err) {
          // Skip an individual file that fails to open rather than corrupting the whole zip.
          console.error(`[assets/download-zip] skipped ${asset.name}:`, err);
        }
      }
      await archive.finalize();
    } catch (err) {
      passthrough.destroy(err as Error);
    }
  })();

  const zipName = (body.zipName?.trim() || 'assets').replace(/[/\\]/g, '_') + '.zip';

  return new NextResponse(
    Readable.toWeb(passthrough) as unknown as ReadableStream,
    {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName.replace(/"/g, '\\"')}"`,
      },
    },
  );
}
