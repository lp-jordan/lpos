import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getClientOwnerStore, getProjectStore } from '@/lib/services/container';
import { getActivityDb } from '@/lib/store/activity-db';

interface ActivityRow {
  event_id: string;
  occurred_at: string;
  event_type: string;
  lifecycle_phase: string;
  title: string;
  summary: string | null;
  project_id: string | null;
  client_id: string | null;
  actor_display: string | null;
  actor_type: string | null;
}

export async function GET() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Find clients this user owns.
  const owners = getClientOwnerStore().getAll();
  const ownedClients = Object.entries(owners)
    .filter(([, uid]) => uid === session.userId)
    .map(([clientName]) => clientName);

  if (ownedClients.length === 0) {
    return NextResponse.json({ activity: [] });
  }

  // Find projectIds for those clients.
  const allProjects = getProjectStore().getAll();
  const projectIds = allProjects
    .filter((p) => ownedClients.includes(p.clientName))
    .map((p) => p.projectId);

  if (projectIds.length === 0) {
    return NextResponse.json({ activity: [] });
  }

  // Query activity_events for those projects.
  const db = getActivityDb();
  const placeholders = projectIds.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT event_id, occurred_at, event_type, lifecycle_phase, title, summary,
            project_id, client_id, actor_display, actor_type
     FROM activity_events
     WHERE project_id IN (${placeholders})
       AND visibility = 'user_timeline'
     ORDER BY occurred_at DESC
     LIMIT 20`,
  ).all(...projectIds) as ActivityRow[];

  return NextResponse.json({ activity: rows });
}
