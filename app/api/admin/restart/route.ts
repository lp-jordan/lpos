/**
 * POST /api/admin/restart
 *
 * Initiates a 60-second broadcast countdown then exits with code 75, signalling
 * the Electron server console to rebuild and restart the process.
 *
 * Only accessible to admin role.
 * Blocked when any ingest, transcription, or upload job is active.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import {
  getIngestQueueService,
  getTranscripterService,
  getUploadQueueService,
} from '@/lib/services/container';

const COUNTDOWN_SECONDS = 60;

// Must match EXIT_CODE_RESTART in lpos-server-app/main.js.
// The Electron console detects this exit code and triggers a rebuild + restart.
const EXIT_CODE_RESTART = 75;

const INGEST_ACTIVE     = new Set(['queued', 'ingesting', 'awaiting_confirmation']);
const TRANSCRIPT_ACTIVE = new Set(['queued', 'extracting_audio', 'transcribing', 'writing_outputs']);
const UPLOAD_ACTIVE     = new Set(['queued', 'compressing', 'uploading', 'processing']);

export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  // ── Duplicate-trigger guard ─────────────────────────────────────────────────
  if (globalThis.__lpos_restartPending) {
    return NextResponse.json({ error: 'already_pending' }, { status: 409 });
  }

  // ── Active-job check ────────────────────────────────────────────────────────
  const activeIngest = getIngestQueueService()
    .getQueue()
    .filter((j) => INGEST_ACTIVE.has(j.status)).length;

  const activeTranscripts = getTranscripterService()
    .getQueue()
    .filter((j) => TRANSCRIPT_ACTIVE.has(j.status)).length;

  const activeUploads = getUploadQueueService()
    .getQueue()
    .filter((j) => UPLOAD_ACTIVE.has(j.status)).length;

  if (activeIngest > 0 || activeTranscripts > 0 || activeUploads > 0) {
    return NextResponse.json(
      {
        error: 'jobs_in_progress',
        counts: { ingest: activeIngest, transcripts: activeTranscripts, uploads: activeUploads },
      },
      { status: 409 },
    );
  }

  // ── Socket.IO ───────────────────────────────────────────────────────────────
  const io = globalThis.__lpos_io;
  if (!io) {
    return NextResponse.json({ error: 'server_not_ready' }, { status: 503 });
  }

  // ── Countdown → exit 75 ─────────────────────────────────────────────────────
  // The SIGTERM handler in server.ts reads __lpos_exitCode and passes it to
  // process.exit(), so the Electron console sees code 75 and triggers a rebuild.
  globalThis.__lpos_restartPending = true;
  let secondsLeft = COUNTDOWN_SECONDS;

  io.emit('server:restart-countdown', { secondsLeft });

  const tick = setInterval(() => {
    secondsLeft--;
    io.emit('server:restart-countdown', { secondsLeft });

    if (secondsLeft <= 0) {
      clearInterval(tick);
      (globalThis as Record<string, unknown>).__lpos_exitCode = EXIT_CODE_RESTART;
      process.kill(process.pid, 'SIGTERM');
    }
  }, 1_000);

  return NextResponse.json({ started: true, secondsLeft: COUNTDOWN_SECONDS });
}
