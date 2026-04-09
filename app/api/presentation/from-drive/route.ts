/**
 * POST /api/presentation/from-drive
 *
 * Loads a Drive asset directly into the presentation service — no file upload needed.
 * Supports:
 *   - Google Slides  (application/vnd.google-apps.presentation) — exported to PDF by Drive
 *   - PPTX / PPT / ODP                                          — downloaded, converted via LibreOffice
 *   - PDF                                                        — downloaded, rendered directly
 *
 * Body: { projectId: string; entityId: string }
 *
 * On success the PresentationService fires its Socket.IO broadcast so all
 * connected clients (including the Slate page) switch to the new presentation
 * immediately.
 */

import os   from 'node:os';
import fs   from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore, getPresentationService } from '@/lib/services/container';
import { getDriveAssetsByProject } from '@/lib/store/drive-sync-db';
import { downloadFile, exportFile } from '@/lib/services/drive-client';
import {
  convertPdfToImages,
  convertPptxToImages,
  PRESENTATION_TEMP_DIR,
} from '@/lib/services/presentation-service';
import { randomUUID } from 'node:crypto';

const IMPRESS_EXTS = new Set(['.ppt', '.pptx', '.odp']);
const GSLIDES_MIME = 'application/vnd.google-apps.presentation';

export async function POST(req: NextRequest) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  let body: { projectId?: string; entityId?: string };
  try {
    body = await req.json() as { projectId?: string; entityId?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { projectId, entityId } = body;
  if (!projectId || !entityId) {
    return NextResponse.json({ error: 'projectId and entityId are required' }, { status: 400 });
  }

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const all   = getDriveAssetsByProject(projectId);
  const asset = all.find((a) => a.entityId === entityId && a.entityType === 'asset' && !a.isFolder);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const mime     = asset.mimeType ?? '';
  const ext      = asset.name.slice(asset.name.lastIndexOf('.')).toLowerCase();
  const isGSlides = mime === GSLIDES_MIME;
  const isImpress = IMPRESS_EXTS.has(ext);
  const isPdf     = ext === '.pdf' || mime === 'application/pdf';

  if (!isGSlides && !isImpress && !isPdf) {
    return NextResponse.json(
      { error: 'Only Google Slides, PPTX/PPT/ODP, and PDF files can be loaded as presentations' },
      { status: 415 },
    );
  }

  const outDir = path.join(PRESENTATION_TEMP_DIR, randomUUID());
  const name   = asset.name.replace(/\.[^.]+$/, '') || 'Presentation';

  try {
    let slides: string[];

    if (isGSlides) {
      // Google Slides → export as PDF from Drive, then render pages to PNG
      const pdfBuffer = await exportFile(asset.driveFileId, 'application/pdf');
      const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'lpos-gslides-'));
      try {
        const pdfPath = path.join(tmpDir, `${name}.pdf`);
        fs.writeFileSync(pdfPath, pdfBuffer);
        slides = await convertPdfToImages(pdfPath, outDir);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } else {
      // Binary file — download from Drive
      const buffer  = await downloadFile(asset.driveFileId);
      const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'lpos-pres-'));
      try {
        const filePath = path.join(tmpDir, asset.name);
        fs.writeFileSync(filePath, buffer);
        slides = isPdf
          ? await convertPdfToImages(filePath, outDir)
          : await convertPptxToImages(filePath, outDir);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }

    if (slides.length === 0) {
      return NextResponse.json({ error: 'Conversion produced no slides' }, { status: 422 });
    }

    getPresentationService().loadPresentation(name, slides);
    return NextResponse.json({ name, totalSlides: slides.length });
  } catch (err) {
    // Clean up output dir on failure
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.error('[presentation/from-drive] error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
