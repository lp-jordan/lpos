import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getActivityDb } from '@/lib/store/activity-db';
import {
  BUCKET_EVENT_PREFIXES,
  type ActivityBucket,
} from '@/lib/models/activity-bucket';

export interface RecentActivityRow {
  event_id: string;
  occurred_at: string;
  event_type: string;
  lifecycle_phase: string;
  title: string;
  summary: string | null;
  project_id: string | null;
  client_id: string | null;
  actor_id: string | null;
  actor_display: string | null;
  actor_type: string | null;
}

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 200;

// Org-wide recent activity for the dashboard strip and history modal. Unlike
// /api/dashboard/activity (which scopes to the signed-in user's owned clients),
// this endpoint returns user_timeline events across every project — same content
// for everyone. Visibility is hardcoded to 'user_timeline' so operator/debug
// events don't bleed into the dashboard surface.
export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = req.nextUrl;
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const before = url.searchParams.get('before');           // ISO timestamp cursor (exclusive)
  const projectId = url.searchParams.get('projectId');     // exact match
  const actorId = url.searchParams.get('actorId');         // exact match
  const q = url.searchParams.get('q')?.trim() ?? '';       // free-text search on title/summary
  const bucket = url.searchParams.get('bucket') as ActivityBucket | null;

  const where: string[] = [`visibility = 'user_timeline'`];
  const params: string[] = [];
  if (before) { where.push(`occurred_at < ?`); params.push(before); }
  if (projectId) { where.push(`project_id = ?`); params.push(projectId); }
  if (actorId) { where.push(`actor_id = ?`); params.push(actorId); }
  if (q) {
    where.push(`(title LIKE ? OR summary LIKE ? OR search_text LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  // Bucket filter: translate the coarse user-facing bucket into a set of
  // `event_type LIKE 'prefix%'` OR clauses. If the bucket isn't recognised,
  // ignore it (return all).
  if (bucket && BUCKET_EVENT_PREFIXES[bucket]) {
    const prefixes = BUCKET_EVENT_PREFIXES[bucket];
    const clauses = prefixes.map(() => `event_type LIKE ?`);
    where.push(`(${clauses.join(' OR ')})`);
    for (const p of prefixes) params.push(`${p}%`);
  }

  const db = getActivityDb();
  let rows: RecentActivityRow[];
  try {
    rows = db.prepare(
      `SELECT event_id, occurred_at, event_type, lifecycle_phase, title, summary,
              project_id, client_id, actor_id, actor_display, actor_type
       FROM activity_events
       WHERE ${where.join(' AND ')}
       ORDER BY occurred_at DESC, recorded_at DESC
       LIMIT ?`,
    ).all(...params, limit) as RecentActivityRow[];
  } catch {
    rows = [];
  }

  return NextResponse.json({
    activity: rows,
    hasMore: rows.length === limit,
  });
}
