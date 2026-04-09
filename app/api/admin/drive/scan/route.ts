/**
 * POST /api/admin/drive/scan
 *
 * Two-way sync for all projects:
 *   1. Walks every project's Assets folder in Drive → indexes files not yet in LPOS
 *   2. Pushes every local transcript not yet in Drive → uploads to Transcripts folder
 *
 * Idempotent — safe to re-run. Admin-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getDriveWatcherService } from '@/lib/services/container';
import { pushAllExistingTranscripts } from '@/lib/services/drive-transcript-sync';

export async function POST(req: NextRequest) {
  const authError = await requireRole(req, 'admin');
  if (authError) return authError;

  const watcher = getDriveWatcherService();
  if (!watcher) {
    return NextResponse.json(
      { error: 'DriveWatcherService is not running — check env vars and restart server' },
      { status: 500 },
    );
  }

  try {
    const [fileCount, transcriptCount] = await Promise.all([
      watcher.scanAllProjectAssets(),
      pushAllExistingTranscripts(),
    ]);
    return NextResponse.json({ ok: true, fileCount, transcriptCount });
  } catch (err) {
    console.error('[admin/drive/scan] error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
