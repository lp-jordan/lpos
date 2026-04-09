/**
 * POST /api/ingest/[projectId]/promote
 *
 * Queues one or more ingest files for promotion into official LPOS storage.
 *
 * Body: {
 *   files: Array<{
 *     fileKey:  string;   // R2 object key from ingest_submissions
 *     filename: string;
 *     mimeType: string;
 *     fileSize: number;
 *   }>;
 *   destination: 'assets' | 'scripts';  // which LPOS collection to land in
 * }
 *
 * Returns: { jobIds: string[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore, getPromotionQueueService } from '@/lib/services/container';
import type { PromotionDestination } from '@/lib/services/promotion-queue-service';

type Ctx = { params: Promise<{ projectId: string }> };

interface PromoteFileInput {
  fileKey:  string;
  filename: string;
  mimeType: string;
  fileSize: number;
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  let body: { files: PromoteFileInput[]; destination: PromotionDestination };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { files, destination } = body;

  if (!Array.isArray(files) || files.length === 0) {
    return NextResponse.json({ error: 'files must be a non-empty array' }, { status: 400 });
  }
  if (destination !== 'assets' && destination !== 'scripts') {
    return NextResponse.json({ error: 'destination must be "assets" or "scripts"' }, { status: 400 });
  }

  // Validate each file entry
  for (const f of files) {
    if (!f.fileKey || !f.filename || !f.mimeType || typeof f.fileSize !== 'number') {
      return NextResponse.json(
        { error: 'Each file must have fileKey, filename, mimeType, and fileSize' },
        { status: 400 },
      );
    }
  }

  const promotionQueue = getPromotionQueueService();
  const jobIds = files.map((f) =>
    promotionQueue.add(projectId, f.filename, f.fileKey, f.mimeType, f.fileSize, destination),
  );

  return NextResponse.json({ jobIds });
}
