/**
 * POST /api/projects/[projectId]/scripts/from-asset
 *
 * Pulls a file from the project's Drive assets and registers it as a script.
 * Supported types:
 *   - .pdf, .doc, .docx, .txt  → downloaded as-is from Drive
 *   - Google Docs (GDOC)       → exported to PDF via Drive export API
 *
 * Body: { assetId: string }   (the DriveAsset entityId)
 */

import { NextRequest, NextResponse } from 'next/server';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { getProjectStore }         from '@/lib/services/container';
import { getDriveAssetsByProject } from '@/lib/store/drive-sync-db';
import { downloadFile, exportFile } from '@/lib/services/drive-client';
import {
  registerScript,
  patchScript,
  scriptsDir,
} from '@/lib/store/scripts-registry';
import { extractAndSave }     from '@/lib/services/script-extractor';
import { pushScriptToDrive }  from '@/lib/services/drive-script-sync';

type Ctx = { params: Promise<{ projectId: string }> };

const GDOC_MIME = 'application/vnd.google-apps.document';

const ALLOWED_EXTS: Record<string, string> = {
  '.pdf':  'application/pdf',
  '.doc':  'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt':  'text/plain',
};

interface TransferSpec {
  ext:        string;
  outputMime: string;
  isExport:   boolean;
  baseName:   string;
}

function resolveTransfer(name: string, mimeType: string | null): TransferSpec | null {
  // Google Docs → export as PDF
  if (mimeType === GDOC_MIME) {
    const stem = name.replace(/\.[^.]*$/, '');
    return { ext: '.pdf', outputMime: 'application/pdf', isExport: true, baseName: `${stem}.pdf` };
  }

  const ext = path.extname(name).toLowerCase();
  const mime = ALLOWED_EXTS[ext];
  if (mime) {
    return { ext, outputMime: mime, isExport: false, baseName: name };
  }

  return null;
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const body = await req.json() as { assetId?: string };
  if (!body.assetId) return NextResponse.json({ error: 'assetId is required' }, { status: 400 });

  const all   = getDriveAssetsByProject(projectId);
  const asset = all.find((a) => a.entityId === body.assetId && a.entityType === 'asset' && !a.isFolder);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const transfer = resolveTransfer(asset.name, asset.mimeType);
  if (!transfer) {
    return NextResponse.json(
      { error: 'This file type cannot be sent to Scripts. Supported: .pdf, .doc, .docx, .txt, GDOC' },
      { status: 422 },
    );
  }

  const dir     = scriptsDir(projectId);
  const tmpPath = path.join(os.tmpdir(), `lpos-script-from-asset-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const buffer = transfer.isExport
      ? await exportFile(asset.driveFileId, 'application/pdf')
      : await downloadFile(asset.driveFileId);

    fs.writeFileSync(tmpPath, buffer);

    const script = registerScript({
      projectId,
      originalFilename: transfer.baseName,
      filePath:         tmpPath,
      fileSize:         buffer.length,
      mimeType:         transfer.outputMime,
    });

    const finalPath = path.join(dir, `${script.scriptId}${transfer.ext}`);
    fs.renameSync(tmpPath, finalPath);
    patchScript(projectId, script.scriptId, { filePath: finalPath });

    void extractAndSave(projectId, script.scriptId, finalPath, transfer.ext);
    void pushScriptToDrive(projectId, script.scriptId, finalPath, script.name);

    return NextResponse.json({ script: { ...script, filePath: finalPath } }, { status: 201 });
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    console.error('[scripts/from-asset] error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
