import { NextResponse } from 'next/server';
import { getIngestQueueDb } from '@/lib/store/ingest-queue-db';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

interface HistoryRow {
  filename: string;
  queued_at: string;
  completed_at: string;
}

export function GET() {
  try {
    const db = getIngestQueueDb();
    const cutoff = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
    const rows = db.prepare(
      `SELECT filename, queued_at, completed_at
       FROM ingest_jobs
       WHERE status = 'done'
         AND queued_at >= ?
       ORDER BY queued_at DESC`
    ).all(cutoff) as HistoryRow[];

    const jobs = rows.map((r) => ({
      filename:    r.filename,
      queuedAt:    r.queued_at,
      completedAt: r.completed_at,
    }));

    return NextResponse.json({ jobs });
  } catch {
    return NextResponse.json({ jobs: [] });
  }
}
