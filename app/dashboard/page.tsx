import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById, getAllUsers, toUserSummary } from '@/lib/store/user-store';
import {
  getClientOwnerStore,
  getProjectStore,
  getTaskStore,
  getTaskCommentStore,
  getProjectNoteStore,
} from '@/lib/services/container';
import { getActivityDb } from '@/lib/store/activity-db';
import { DashboardClient } from '@/components/dashboard/DashboardClient';
import type { Project } from '@/lib/models/project';

interface ActivityRow {
  event_id: string;
  occurred_at: string;
  event_type: string;
  title: string;
  summary: string | null;
  project_id: string | null;
  actor_display: string | null;
  actor_type: string | null;
}

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) redirect('/signin');

  const user = getUserById(session.userId);
  if (!user) redirect('/signin');

  // All active projects (for NewTaskModal picker)
  const allProjects: Project[] = getProjectStore()
    .getAll()
    .filter((p) => !p.archived);

  // Owned clients for this user
  const owners = getClientOwnerStore().getAll();
  const ownedClients = Object.entries(owners)
    .filter(([, uid]) => uid === session.userId)
    .map(([clientName]) => clientName);

  // Projects for owned clients (non-archived) for the status section
  const projects: Project[] = allProjects.filter((p) => ownedClients.includes(p.clientName));

  // Recent activity for owned projects
  let activity: ActivityRow[] = [];
  if (projects.length > 0) {
    const projectIds = projects.map((p) => p.projectId);
    const placeholders = projectIds.map(() => '?').join(', ');
    try {
      activity = getActivityDb()
        .prepare(
          `SELECT event_id, occurred_at, event_type, title, summary,
                  project_id, actor_display, actor_type
           FROM activity_events
           WHERE project_id IN (${placeholders})
             AND visibility = 'user_timeline'
           ORDER BY occurred_at DESC
           LIMIT 20`,
        )
        .all(...projectIds).map((r) => ({ ...(r as ActivityRow) })) as ActivityRow[];
    } catch {
      // Activity DB may not be populated yet.
    }
  }

  // Tasks for this user
  const tasks = getTaskStore().getForUser(session.userId);
  const commentCounts: Record<string, number> = {};
  const commentStore = getTaskCommentStore();
  for (const task of tasks) {
    commentCounts[task.taskId] = commentStore.getCountForTask(task.taskId);
  }

  // Unresolved handoff notes tagged to this user
  const notes = getProjectNoteStore().getUnresolvedForUser(session.userId);

  // All users for assignee picker and note author map
  const allUsers = getAllUsers();
  const users = allUsers.map((u) => toUserSummary(u)).filter(Boolean) as NonNullable<ReturnType<typeof toUserSummary>>[];
  const userMap = Object.fromEntries(allUsers.map((u) => [u.id, u.name]));

  const firstName = user.name.split(' ')[0];

  return (
    <DashboardClient
      firstName={firstName}
      userId={session.userId}
      projects={projects}
      allProjects={allProjects}
      users={users}
      activity={activity}
      tasks={tasks}
      commentCounts={commentCounts}
      notes={notes}
      userMap={userMap}
    />
  );
}
