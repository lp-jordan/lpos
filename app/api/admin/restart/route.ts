/**
 * POST /api/admin/restart
 *
 * Initiates a 60-second broadcast countdown then restarts the server process.
 * Only accessible to jordan@leaderpass.com.
 * Blocked when any ingest, transcription, or upload job is active.
 */

import { spawn } from 'node:child_process';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import {
  getIngestQueueService,
  getTranscripterService,
  getUploadQueueService,
} from '@/lib/services/container';

const COUNTDOWN_SECONDS = 60;

const INGEST_ACTIVE = new Set(['queued', 'ingesting', 'awaiting_confirmation']);
const TRANSCRIPT_ACTIVE = new Set(['queued', 'extracting_audio', 'transcribing', 'writing_outputs']);
const UPLOAD_ACTIVE = new Set(['queued', 'compressing', 'uploading', 'processing']);

/**
 * Spawn a detached child that waits a few seconds for the current process to
 * fully release the port, then re-runs `npm start` in the same directory.
 * The child is unref'd so it outlives this process.
 */
function scheduleRestart(): void {
  const cwd = process.cwd();
  const isWindows = process.platform === 'win32';

  const child = isWindows
    ? spawn('cmd', ['/c', 'timeout /t 4 /nobreak >nul && npm run build && npm start'], {
        cwd,
        detached: true,
        stdio: 'ignore',
        shell: false,
      })
    : spawn('sh', ['-c', 'sleep 4 && npm run build && npm start'], {
        cwd,
        detached: true,
        stdio: 'ignore',
      });

  child.unref();
}

export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const body = await req.json().catch(() => ({})) as { autoRestart?: boolean };
  const autoRestart = body.autoRestart !== false; // default true

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

  // ── Countdown ───────────────────────────────────────────────────────────────
  globalThis.__lpos_restartPending = true;
  let secondsLeft = COUNTDOWN_SECONDS;

  io.emit('server:restart-countdown', { secondsLeft });

  const tick = setInterval(() => {
    secondsLeft--;
    io.emit('server:restart-countdown', { secondsLeft });

    if (secondsLeft <= 0) {
      clearInterval(tick);
      if (autoRestart) scheduleRestart();
      process.kill(process.pid, 'SIGTERM');
    }
  }, 1_000);

  return NextResponse.json({ started: true, secondsLeft: COUNTDOWN_SECONDS });
}
