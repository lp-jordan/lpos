/**
 * POST /api/projects/[projectId]/assets/upload
 *
 * Accepts a multipart/form-data body with one or more files under the key
 * "file". Each file is uploaded directly to the project's Drive assets
 * folder and the project's asset index is re-scanned afterward.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore, getDriveWatcherService } from '@/lib/services/container';
import { uploadFile } from '@/lib/services/drive-client';
import { resolveAssetsFolder } from '@/lib/services/drive-folder-service';

type Ctx = { params: Promise<{ projectId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const folderId = resolveAssetsFolder(project.name, project.clientName);
  if (!folderId) {
    return NextResponse.json(
      { error: 'Assets folder not found — Drive may still be initialising. Try again in a moment.' },
      { status: 503 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }

  const files = formData.getAll('file') as File[];
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files provided' }, { status: 400 });
  }

  const results: { name: string; fileId: string }[] = [];
  const errors:  { name: string; error: string }[]  = [];

  for (const file of files) {
    try {
      const buffer   = Buffer.from(await file.arrayBuffer());
      const mimeType = file.type || 'application/octet-stream';
      const result   = await uploadFile(file.name, mimeType, buffer, folderId);
      results.push({ name: file.name, fileId: result.fileId });
    } catch (err) {
      errors.push({ name: file.name, error: (err as Error).message });
    }
  }

  // Sync so newly uploaded files appear immediately without waiting for the
  // next Drive push notification.
  try {
    const watcher = getDriveWatcherService();
    if (watcher) await watcher.scanProjectAssets(projectId);
  } catch {
    // Non-fatal — Drive watcher will catch the files on its next cycle.
  }

  if (results.length === 0) {
    return NextResponse.json(
      { error: `All uploads failed`, errors },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, uploaded: results.length, errors });
}
