import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById, getAllUsers } from '@/lib/store/user-store';
import {
  getClientOwnerStore,
  getProjectStore,
  getTaskStore,
  getProjectNoteStore,
} from '@/lib/services/container';
import { getActivityDb } from '@/lib/store/activity-db';
import { DashboardClient } from '@/components/dashboard/DashboardClient';
import type { Project } from '@/lib/models/project';

interface ActivityRow {
  event_id: string;
  occurred_at: string;
  title: string;
  summary: string | null;
  project_id: string | null;
}

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) redirect('/signin');

  const user = getUserById(session.userId);
  if (!user) redirect('/signin');

  // Owned clients for this user.
  const owners = getClientOwnerStore().getAll();
  const ownedClients = Object.entries(owners)
    .filter(([, uid]) => uid === session.userId)
    .map(([clientName]) => clientName);

  // Projects for owned clients (non-archived).
  const projects: Project[] = getProjectStore()
    .getAll()
    .filter((p) => !p.archived && ownedClients.includes(p.clientName));

  // Recent activity for those projects.
  let activity: ActivityRow[] = [];
  if (projects.length > 0) {
    const projectIds = projects.map((p) => p.projectId);
    const placeholders = projectIds.map(() => '?').join(', ');
    try {
      activity = getActivityDb()
        .prepare(
          `SELECT event_id, occurred_at, title, summary, project_id
           FROM activity_events
           WHERE project_id IN (${placeholders})
             AND visibility = 'user_timeline'
           ORDER BY occurred_at DESC
           LIMIT 20`,
        )
        .all(...projectIds) as ActivityRow[];
    } catch {
      // Activity DB may not be populated yet.
    }
  }

  // Tasks for this user.
  const tasks = getTaskStore().getForUser(session.userId);

  // Unresolved handoff notes tagged to this user.
  const notes = getProjectNoteStore().getUnresolvedForUser(session.userId);

  // Build a userId → display name map for note authors.
  const allUsers = getAllUsers();
  const userMap = Object.fromEntries(allUsers.map((u) => [u.id, u.name]));

  const firstName = user.name.split(' ')[0];

  return (
    <DashboardClient
      firstName={firstName}
      userId={session.userId}
      projects={projects}
      activity={activity}
      tasks={tasks}
      notes={notes}
      userMap={userMap}
    />
  );
}
