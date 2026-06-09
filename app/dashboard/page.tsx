import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById, getAllUsers, toUserSummary } from '@/lib/store/user-store';
import { getProjectStore, getTaskStore, getTaskCommentStore } from '@/lib/services/container';
import { DashboardClient } from '@/components/dashboard/DashboardClient';
import { getPhaseStatusesForType } from '@/lib/store/task-phase-config-store';
import { canEditPreprodColumns } from '@/lib/store/preprod-board-admin-store';
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

  // Pre-Production board: configurable columns + per-user edit permission.
  // Empty list is fine — the kanban renders an empty-state with a CTA for
  // permitted users to open the column editor.
  const preprodStatuses = getPhaseStatusesForType('preprod');
  const canEditPreprodCols = canEditPreprodColumns(session.userId, session.role === 'admin');

  const firstName = user.name.split(' ')[0];

  return (
    <DashboardClient
      firstName={firstName}
      userId={session.userId}
      allProjects={allProjects}
      users={users}
      tasks={tasks}
      commentCounts={commentCounts}
      preprodStatuses={preprodStatuses}
      canEditPreprodCols={canEditPreprodCols}
    />
  );
}
