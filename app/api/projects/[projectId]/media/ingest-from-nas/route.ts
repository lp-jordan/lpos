import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById } from '@/lib/store/user-store';
import { getProjectStore } from '@/lib/services/container';
import { resolveProjectMediaStorageDir } from '@/lib/services/storage-volume-service';
import { findCanonicalVersionCandidate } from '@/lib/store/canonical-asset-store';
import { hashFile, finalizeUploadedAsset } from '@/lib/services/media-finalization';
import { resolveRequestActor } from '@/lib/services/activity-actor';

type Ctx = { params: Promise<{ projectId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = getUserById(session.userId);
  if (!user?.nasIngestAccess) {
    return NextResponse.json({ error: 'NAS ingest access not granted' }, { status: 403 });
  }

  const { projectId } = await params;

  // ── Project ─────────────────────────────────────────────────────────────────
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  // ── Body ────────────────────────────────────────────────────────────────────
  const body = await req.json() as { sourcePath?: string; replaceAssetId?: string };
  const sourcePath = body.sourcePath?.trim();
  if (!sourcePath) return NextResponse.json({ error: 'sourcePath is required' }, { status: 400 });

  const normalizedSource = path.normalize(sourcePath);

  // ── Validate source file ────────────────────────────────────────────────────
  if (!fs.existsSync(normalizedSource)) {
    return NextResponse.json({ error: 'File not found at the specified path' }, { status: 422 });
  }
  const sourceStat = fs.statSync(normalizedSource);
  if (!sourceStat.isFile()) {
    return NextResponse.json({ error: 'Path must point to a file, not a directory' }, { status: 422 });
  }

  // ── Resolve project media dir ────────────────────────────────────────────────
  let mediaDir: string;
  try {
    mediaDir = resolveProjectMediaStorageDir(projectId);
  } catch {
    return NextResponse.json({ error: 'No storage volume configured' }, { status: 503 });
  }

  const filename = path.basename(normalizedSource);
  const ext = path.extname(filename).toLowerCase();

  // ── Hash source file ─────────────────────────────────────────────────────────
  // Done before copying so we can detect duplicates/versions without wasting
  // time on the copy if we're going to reject anyway.
  let hash: string;
  try {
    hash = await hashFile(normalizedSource);
  } catch {
    return NextResponse.json({ error: 'Failed to read source file' }, { status: 500 });
  }

  // ── Version / duplicate pre-check ────────────────────────────────────────────
  if (!body.replaceAssetId) {
    const candidate = findCanonicalVersionCandidate(projectId, filename, normalizedSource, hash);

    if (candidate?.duplicate) {
      return NextResponse.json({
        error: `This file already matches the current version of ${candidate.asset.name}.`,
        code: 'duplicate_version',
        existingAsset: candidate.asset,
      }, { status: 409 });
    }

    if (candidate) {
      return NextResponse.json({
        error: `This looks like a new version of ${candidate.asset.name}. Confirm to replace the existing pipeline asset.`,
        code: 'version_confirmation_required',
        existingAsset: candidate.asset,
        currentVersionNumber: candidate.currentVersionNumber,
      }, { status: 409 });
    }
  }

  // ── Copy source → temp in media dir ─────────────────────────────────────────
  // Using a recognisable prefix so stale temps are easy to identify.
  const tempPath = path.join(mediaDir, `nas-ingest-${randomUUID()}${ext}`);
  try {
    await fs.promises.copyFile(normalizedSource, tempPath);
  } catch {
    return NextResponse.json({ error: 'Failed to copy file into LPOS storage' }, { status: 500 });
  }

  // ── Finalize ─────────────────────────────────────────────────────────────────
  // From here the flow is identical to a completed browser upload.
  // finalizeUploadedAsset will rename temp → stable (instant, same directory),
  // register the asset, and kick off thumbnail/transcription/Frame.io in background.
  const actor = resolveRequestActor(req);
  try {
    const result = await finalizeUploadedAsset({
      projectId,
      project,
      filename,
      tempPath,
      mediaDir,
      preComputedHash: hash,
      replaceAssetId: body.replaceAssetId,
      actor,
    });

    if (result.outcome === 'registered') {
      return NextResponse.json({ asset: result.asset }, { status: 201 });
    }

    // Shouldn't be reached since we pre-checked, but handle defensively.
    fs.unlink(tempPath, () => {});
    if (result.outcome === 'duplicate') {
      return NextResponse.json({
        error: 'Duplicate file.',
        code: 'duplicate_version',
        existingAsset: result.asset,
      }, { status: 409 });
    }
    return NextResponse.json({ error: 'Unexpected finalization state' }, { status: 500 });

  } catch (err) {
    fs.unlink(tempPath, () => {});
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
