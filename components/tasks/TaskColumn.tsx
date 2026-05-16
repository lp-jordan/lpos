'use client';

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Task } from '@/lib/models/task';
import type { UserSummary } from '@/lib/models/user';
import { TaskCard } from './TaskCard';

interface Props {
  status: string;
  label: string;
  color: string;
  isTerminal: boolean;
  showAddButton: boolean;
  tasks: Task[];
  users: UserSummary[];
  commentCounts: Record<string, number>;
  selectedTaskId: string | null;
  renamingTaskId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectTask: (taskId: string) => void;
  onAddTask: () => void;
  onCardContextMenu: (e: React.MouseEvent, taskId: string) => void;
  onRenameCommit: (taskId: string, title: string) => void;
  onRenameCancel: () => void;
}

export function TaskColumn({
  status,
  label,
  color,
  isTerminal,
  showAddButton,
  tasks,
  users,
  commentCounts,
  selectedTaskId,
  renamingTaskId,
  collapsed,
  onToggleCollapse,
  onSelectTask,
  onAddTask,
  onCardContextMenu,
  onRenameCommit,
  onRenameCancel,
}: Readonly<Props>) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div ref={setNodeRef} className={`task-col${isOver ? ' task-col--over' : ''}`}>
      <div className="task-col-header">
        <div className="task-col-header-left">
          <span className="task-col-dot" style={{ background: color }} />
          <span className="task-col-label">{label}</span>
          <span className="task-col-count">{tasks.length}</span>
        </div>
        <div className="task-col-header-right">
          {isTerminal && (
            <button
              type="button"
              className="task-col-collapse-btn"
              onClick={onToggleCollapse}
              title={collapsed ? 'Expand done' : 'Collapse done'}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          )}
          {/* Small header "+" intentionally dropped — when showAddButton is true
              we render a full-width gold button at the top of the body instead
              (matches the look of the prior toolbar "+ New Task" button). */}
        </div>
      </div>

      {(!isTerminal || !collapsed) && (
        <div className="task-col-body">
          {showAddButton && (
            <button
              type="button"
              className="task-col-add-btn-full"
              onClick={onAddTask}
            >
              + New Task
            </button>
          )}
          <SortableContext items={tasks.map((t) => t.taskId)} strategy={verticalListSortingStrategy}>
            {tasks.map((task) => (
              <TaskCard
                key={task.taskId}
                task={task}
                users={users}
                commentCount={commentCounts[task.taskId] ?? 0}
                selected={selectedTaskId === task.taskId}
                isRenaming={renamingTaskId === task.taskId}
                onClick={() => onSelectTask(task.taskId)}
                onContextMenu={(e) => onCardContextMenu(e, task.taskId)}
                onRenameCommit={(title) => onRenameCommit(task.taskId, title)}
                onRenameCancel={onRenameCancel}
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
