'use client';

import type { Project } from '@/lib/models/project';
import type { Task } from '@/lib/models/task';
import type { TaskTypeStatus } from '@/lib/models/task-phase';
import type { UserSummary } from '@/lib/models/user';
import { TaskBoard } from '@/components/tasks/TaskBoard';
import { ActivityStrip } from '@/components/dashboard/ActivityStrip';
import { PreprodConfigProvider } from '@/components/dashboard/preprod-config-context';

export interface DashboardClientProps {
  firstName:     string;
  userId:        string;
  allProjects:   Project[];
  users:         UserSummary[];
  tasks:         Task[];
  commentCounts: Record<string, number>;
  /** Live Pre-Production column list (slug/label/color) from task_phase_configs.
   *  Empty when no columns have been created yet. */
  preprodStatuses: TaskTypeStatus[];
  /** True for admins + users granted preprod-board-admin in /settings. */
  canEditPreprodCols: boolean;
}

export function DashboardClient({
  firstName,
  userId,
  allProjects,
  users,
  tasks,
  commentCounts,
  preprodStatuses,
  canEditPreprodCols,
}: DashboardClientProps) {
  return (
    <PreprodConfigProvider initialStatuses={preprodStatuses} canEditColumns={canEditPreprodCols}>
      <div className="page-stack">
        <div className="dashboard-header">
          <div className="dashboard-header-titles">
            <h1 className="dashboard-title">My Dashboard</h1>
            <p className="dashboard-subtitle">Welcome back, {firstName}.</p>
          </div>
        </div>

        {/* Primary workspace: full-width Kanban board */}
        <section className="dashboard-board-section">
          <TaskBoard
            initialTasks={tasks}
            allProjects={allProjects}
            users={users}
            currentUserId={userId}
            commentCounts={commentCounts}
          />
        </section>

        {/* Activity strip — sits below the task board, shares its width */}
        <section className="dashboard-activity-section">
          <ActivityStrip
            projectMap={new Map(allProjects.map((p) => [p.projectId, p.name]))}
          />
        </section>
      </div>
    </PreprodConfigProvider>
  );
}
