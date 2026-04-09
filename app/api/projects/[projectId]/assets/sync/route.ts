/**
 * POST /api/projects/[projectId]/assets/sync
 *
 * Polls Drive for new changes (via changes.list + page token) and
 * processes any new files into the asset index. Called when the user
 * opens the Assets tab or hits the refresh button.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getDriveWatcherService } from '@/lib/services/container';

type Ctx = { params: Promise<{ projectId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  const { projectId } = await params;

  const watcher = getDriveWatcherService();
  if (!watcher) return NextResponse.json({ ok: true }); // Drive not configured — no-op

  await watcher.scanProjectAssets(projectId);
  return NextResponse.json({ ok: true });
}
