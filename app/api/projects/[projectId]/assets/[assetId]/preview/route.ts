/**
 * GET /api/projects/[projectId]/assets/[assetId]/preview
 *
 * Serves asset content for in-browser preview:
 *   - Images: proxied inline (no attachment header, browser renders directly)
 *   - DOCX:   converted to PDF via LibreOffice, served inline, result cached to disk
 *
 * DOCX cache lives in {os.tmpdir()}/lpos-docx-preview/.
 * Cache files are named {driveFileId}-{modifiedAtEpoch}.pdf so a changed file
 * automatically gets a new cache entry (old entries cleaned up on next request).
 */

import os   from 'node:os';
import fs   from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getDriveAssetsByProject } from '@/lib/store/drive-sync-db';
import { downloadFile, exportFile } from '@/lib/services/drive-client';
import { convertOfficeToPdf } from '@/lib/services/presentation-service';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/svg+xml',
  'image/heic',
]);

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg', '.heic']);

const OFFICE_EXTS = new Set([
  '.doc', '.docx', '.odt', '.rtf',
  '.xls', '.xlsx', '.ods',
  '.ppt', '.pptx', '.odp',
]);

// Google Workspace native types that can be exported directly to PDF by Drive
const GAPPS_PREVIEWABLE = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
]);

const PDF_MIMES   = new Set(['application/pdf']);
const PDF_EXTS    = new Set(['.pdf']);
const VIDEO_MIMES = new Set([
  'video/mp4', 'video/quicktime', 'video/webm',
  'video/x-msvideo', 'video/x-matroska', 'video/ogg', 'video/x-m4v',
]);
const VIDEO_EXTS  = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.ogv']);

const PDF_CACHE_DIR = path.join(os.tmpdir(), 'lpos-doc-preview');

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

/** Sanitise a Drive file ID for use as a filename component (alphanumeric + hyphen/underscore). */
function safeCacheKey(driveFileId: string): string {
  return driveFileId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Generic cache helper: returns a cached PDF buffer, or calls `produce` to
 * generate one, caches it, and returns it. Stale entries are evicted on write.
 */
async function getCachedOrExport(
  driveFileId: string,
  modifiedAt:  string | null,
  produce:     () => Promise<Buffer>,
): Promise<Buffer> {
  const modifiedEpoch = modifiedAt ? Date.parse(modifiedAt) : 0;
  const baseKey       = safeCacheKey(driveFileId);
  const cacheFile     = path.join(PDF_CACHE_DIR, `${baseKey}-${modifiedEpoch}.pdf`);

  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile);

  // Evict stale entries for this file
  if (fs.existsSync(PDF_CACHE_DIR)) {
    for (const f of fs.readdirSync(PDF_CACHE_DIR)) {
      if (f.startsWith(`${baseKey}-`)) {
        try { fs.unlinkSync(path.join(PDF_CACHE_DIR, f)); } catch { /* ignore */ }
      }
    }
  }

  const pdfBuffer = await produce();
  fs.mkdirSync(PDF_CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, pdfBuffer);
  return pdfBuffer;
}

async function getDocxPdfBuffer(
  driveFileId:  string,
  assetName:  string,
  modifiedAt: string | null,
  buffer:     Buffer,
): Promise<Buffer> {
  return getCachedOrExport(driveFileId, modifiedAt, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpos-office-'));
    try {
      const docPath = path.join(tmpDir, assetName);
      fs.writeFileSync(docPath, buffer);
      const pdfPath  = await convertOfficeToPdf(docPath, tmpDir);
      return fs.readFileSync(pdfPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId, assetId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const all   = getDriveAssetsByProject(projectId);
  const asset = all.find((a) => a.entityId === assetId && a.entityType === 'asset' && !a.isFolder);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const mime        = asset.mimeType ?? 'application/octet-stream';
  const ext         = fileExt(asset.name);
  const isImage     = IMAGE_MIMES.has(mime) || IMAGE_EXTS.has(ext);
  const isOfficeDoc = OFFICE_EXTS.has(ext);
  const isGApps     = GAPPS_PREVIEWABLE.has(mime);
  const isPdf       = PDF_MIMES.has(mime)   || PDF_EXTS.has(ext);
  const isVideo     = VIDEO_MIMES.has(mime) || VIDEO_EXTS.has(ext);

  if (!isImage && !isOfficeDoc && !isGApps && !isPdf && !isVideo) {
    return NextResponse.json({ error: 'Preview not supported for this file type' }, { status: 415 });
  }

  try {
    // ── Helper: read file bytes from local disk or Drive ────────────────────
    const readBytes = async (): Promise<Buffer> => {
      if (asset.source === 'local') {
        if (!asset.localPath || !fs.existsSync(asset.localPath)) {
          throw new Error('Local file not found on disk');
        }
        return fs.readFileSync(asset.localPath);
      }
      return downloadFile(asset.driveFileId);
    };

    if (isImage) {
      const buffer = await readBytes();
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type':  mime === 'application/octet-stream' ? 'image/jpeg' : mime,
          'Cache-Control': 'private, max-age=300',
        },
      });
    }

    if (isPdf) {
      const buffer = await readBytes();
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type':  'application/pdf',
          'Cache-Control': 'private, max-age=300',
        },
      });
    }

    if (isVideo) {
      const buffer   = await readBytes();
      const fileSize = buffer.length;
      const rangeHdr = req.headers.get('range');

      if (rangeHdr) {
        const [startStr, endStr] = rangeHdr.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr, 10);
        const end   = endStr ? parseInt(endStr, 10) : fileSize - 1;
        return new NextResponse(buffer.subarray(start, end + 1), {
          status: 206,
          headers: {
            'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges':  'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type':   mime,
          },
        });
      }

      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Accept-Ranges':  'bytes',
          'Content-Length': String(fileSize),
          'Content-Type':   mime,
          'Cache-Control':  'private, max-age=60',
        },
      });
    }

    // Google Workspace files: export directly to PDF from Drive (no LibreOffice needed)
    // These are always Drive-backed so no local branch needed here.
    if (isGApps) {
      const pdfBuffer = await getCachedOrExport(
        asset.driveFileId,
        asset.modifiedAt ?? null,
        () => exportFile(asset.driveFileId, 'application/pdf'),
      );
      return new NextResponse(pdfBuffer, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=3600' },
      });
    }

    // Binary Office doc → PDF via LibreOffice, cached
    // Cache key is driveFileId for Drive assets; for local assets use entityId
    const cacheKey = asset.source === 'local' ? `local-${asset.entityId}` : asset.driveFileId;
    const buffer = await readBytes();
    const pdfBuffer = await getDocxPdfBuffer(
      cacheKey,
      asset.name,
      asset.modifiedAt ?? null,
      buffer,
    );

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type':  'application/pdf',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (err) {
    console.error('[assets/preview] error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
