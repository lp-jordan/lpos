import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById, getAllUsers, toUserSummary } from '@/lib/store/user-store';
import { getProjectStore, getTaskStore, getTaskCommentStore } from '@/lib/services/container';
import { DashboardClient } from '@/components/dashboard/DashboardClient';
import type { Project } from '@/lib/models/project';

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) redirect('/signin');

  const user = getUserById(session.userId);
  if (!user) redirect('/signin');

  // All active projects (for NewTaskModal picker + ActivityStrip's project name map)
  const allProjects: Project[] = getProjectStore()
    .getAll()
    .filter((p) => !p.archived);

  // Tasks for this user
  const tasks = getTaskStore().getForUser(session.userId);
  const commentCounts: Record<string, number> = {};
  const commentStore = getTaskCommentStore();
  for (const task of tasks) {
    commentCounts[task.taskId] = commentStore.getCountForTask(task.taskId);
  }

  // All users for assignee picker
  const allUsers = getAllUsers();
  const users = allUsers.map((u) => toUserSummary(u)).filter(Boolean) as NonNullable<ReturnType<typeof toUserSummary>>[];

  const firstName = user.name.split(' ')[0];

  return (
    <DashboardClient
      firstName={firstName}
      userId={session.userId}
      allProjects={allProjects}
      users={users}
      tasks={tasks}
      commentCounts={commentCounts}
    />
  );
}
