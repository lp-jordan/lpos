'use client';

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Task, TaskStatus } from '@/lib/models/task';
import type { UserSummary } from '@/lib/models/user';
import { TaskCard } from './TaskCard';

const STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  waiting_on_client: 'Waiting',
  done: 'Done',
};

const STATUS_COLOR: Record<TaskStatus, string> = {
  not_started: '#6b7280',
  in_progress: '#3b82f6',
  blocked: '#ef4444',
  waiting_on_client: '#f59e0b',
  done: '#10b981',
};

interface Props {
  status: TaskStatus;
  tasks: Task[];
  users: UserSummary[];
  commentCounts: Record<string, number>;
  selectedTaskId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectTask: (taskId: string) => void;
  onAddTask: () => void;
}

export function TaskColumn({
  status,
  tasks,
  users,
  commentCounts,
  selectedTaskId,
  collapsed,
  onToggleCollapse,
  onSelectTask,
  onAddTask,
}: Readonly<Props>) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  const isDone = status === 'done';

  return (
    <div className={`task-col${isOver ? ' task-col--over' : ''}`}>
      <div className="task-col-header">
        <div className="task-col-header-left">
          <span className="task-col-dot" style={{ background: STATUS_COLOR[status] }} />
          <span className="task-col-label">{STATUS_LABEL[status]}</span>
          <span className="task-col-count">{tasks.length}</span>
        </div>
        <div className="task-col-header-right">
          {isDone ? (
            <button
              type="button"
              className="task-col-collapse-btn"
              onClick={onToggleCollapse}
              title={collapsed ? 'Expand done' : 'Collapse done'}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          ) : (
            <button
              type="button"
              className="task-col-add-btn"
              onClick={onAddTask}
              title="Add task"
              aria-label="Add task"
            >
              +
            </button>
          )}
        </div>
      </div>

      {(!isDone || !collapsed) && (
        <div ref={setNodeRef} className="task-col-body">
          <SortableContext items={tasks.map((t) => t.taskId)} strategy={verticalListSortingStrategy}>
            {tasks.map((task) => (
              <TaskCard
                key={task.taskId}
                task={task}
                users={users}
                commentCount={commentCounts[task.taskId] ?? 0}
                selected={selectedTaskId === task.taskId}
                onClick={() => onSelectTask(task.taskId)}
              />
            ))}
          </SortableContext>
          {tasks.length === 0 && (
            <div className="task-col-empty">No tasks</div>
          )}
        </div>
      )}
    </div>
  );
}
