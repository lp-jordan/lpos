'use client';

import type { Project } from '@/lib/models/project';
import type { Task } from '@/lib/models/task';
import type { UserSummary } from '@/lib/models/user';
import { TaskBoard } from '@/components/tasks/TaskBoard';
import { ActivityStrip } from '@/components/dashboard/ActivityStrip';

export interface DashboardClientProps {
  firstName:     string;
  userId:        string;
  allProjects:   Project[];
  users:         UserSummary[];
  tasks:         Task[];
  commentCounts: Record<string, number>;
}

export function DashboardClient({
  firstName,
  userId,
  allProjects,
  users,
  tasks,
  commentCounts,
}: DashboardClientProps) {
  return (
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
  );
}
