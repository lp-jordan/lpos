import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectStore } from '@/lib/services/container';
import { registerAsset } from '@/lib/store/media-registry';
import { triggerFrameIOUpload } from '@/lib/services/frameio-upload';
import { findCanonicalVersionCandidate } from '@/lib/store/canonical-asset-store';

type Ctx = { params: Promise<{ projectId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId } = await params;

    const project = getProjectStore().getById(projectId);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const body = await req.json() as {
      filePath: string;
      name?: string;
      description?: string;
      tags?: string[];
      replaceAssetId?: string;
    };

    if (!body.filePath?.trim()) {
      return NextResponse.json({ error: 'filePath is required' }, { status: 400 });
    }

    const normalised = path.normalize(body.filePath.trim());
    const originalFilename = path.basename(normalised);

    let fileSize: number | null = null;
    try {
      if (fs.existsSync(normalised)) {
        fileSize = fs.statSync(normalised).size;
      }
    } catch {
      // Keep the registration flow alive even for temporarily unreachable paths.
    }

    const versionCandidate = !body.replaceAssetId
      ? findCanonicalVersionCandidate(projectId, originalFilename, normalised)
      : null;

    if (versionCandidate?.duplicate) {
      return NextResponse.json({
        error: `This file already matches the current version of ${versionCandidate.asset.name}.`,
        code: 'duplicate_version',
        existingAsset: versionCandidate.asset,
      }, { status: 409 });
    }

    if (versionCandidate) {
      return NextResponse.json({
        error: `This looks like a new version of ${versionCandidate.asset.name}. Confirm to replace the existing pipeline asset.`,
        code: 'version_confirmation_required',
        existingAsset: versionCandidate.asset,
        currentVersionNumber: versionCandidate.currentVersionNumber,
      }, { status: 409 });
    }

    const asset = registerAsset({
      projectId,
      name: body.name,
      description: body.description,
      tags: body.tags,
      originalFilename,
      filePath: normalised,
      fileSize,
      storageType: 'registered',
      existingAssetId: body.replaceAssetId,
    });

    triggerFrameIOUpload(projectId, asset.assetId);

    return NextResponse.json({ asset }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
