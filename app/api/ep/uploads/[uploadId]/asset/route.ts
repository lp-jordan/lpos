import { NextRequest, NextResponse } from 'next/server';
import { requireEpSecret } from '@/lib/services/ep-auth';
import { getIngestQueueDb } from '@/lib/store/ingest-queue-db';
import { readRegistry } from '@/lib/store/media-registry';

type Ctx = { params: Promise<{ uploadId: string }> };

type UploadSessionRow = {
  upload_id: string;
  project_id: string;
  filename: string;
  status: string;
};

/**
 * GET /api/ep/uploads/:uploadId/asset
 *
 * Resolves an upload session ID to a LPOS asset ID.
 * EditPanel calls this after a render upload completes to link the export registry
 * entry to the permanent LPOS asset.
 *
 * Returns { asset: { assetId, projectId, originalFilename } | null, status }
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = requireEpSecret(req);
  if (authError) return authError;

  const { uploadId } = await params;

  const db = getIngestQueueDb();
  const row = db
    .prepare('SELECT upload_id, project_id, filename, status FROM upload_sessions WHERE upload_id = ?')
    .get(uploadId) as UploadSessionRow | undefined;

  if (!row) {
    return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  }

  if (row.status !== 'complete') {
    return NextResponse.json({ asset: null, uploadId: row.upload_id, projectId: row.project_id, status: row.status });
  }

  // Match by originalFilename in the media registry
  const assets = readRegistry(row.project_id);
  const match = assets.find((a) => a.originalFilename === row.filename);

  return NextResponse.json({
    asset: match
      ? { assetId: match.assetId, projectId: row.project_id, originalFilename: match.originalFilename }
      : null,
    uploadId: row.upload_id,
    projectId: row.project_id,
    status: row.status,
  });
}
