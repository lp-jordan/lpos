'use client';

import { useCallback, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { Task, TaskStatus } from '@/lib/models/task';
import type { Project } from '@/lib/models/project';
import type { UserSummary } from '@/lib/models/user';
import { TaskColumn } from './TaskColumn';
import { TaskCard } from './TaskCard';
import { TaskSidePanel } from './TaskSidePanel';
import { NewTaskModal } from '@/components/dashboard/NewTaskModal';

const STATUS_ORDER: TaskStatus[] = ['not_started', 'in_progress', 'blocked', 'waiting_on_client', 'done'];

interface Props {
  initialTasks: Task[];
  allProjects: Project[];
  users: UserSummary[];
  currentUserId: string;
  commentCounts: Record<string, number>;
}

export function TaskBoard({ initialTasks, allProjects, users, currentUserId, commentCounts: initialCommentCounts }: Readonly<Props>) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>(initialCommentCounts);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingTask, setDraggingTask] = useState<Task | null>(null);
  const [doneCollapsed, setDoneCollapsed] = useState(true);
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTaskStatus, setNewTaskStatus] = useState<TaskStatus>('not_started');
  const [filterProject, setFilterProject] = useState('');
  const [filterPriority, setFilterPriority] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const selectedTask = tasks.find((t) => t.taskId === selectedTaskId) ?? null;

  // Filtered tasks
  const filtered = tasks.filter((t) => {
    if (filterProject && t.projectId !== filterProject) return false;
    if (filterPriority && t.priority !== filterPriority) return false;
    return true;
  });

  const byStatus = (status: TaskStatus) => filtered.filter((t) => t.status === status);

  function handleDragStart(event: DragStartEvent) {
    const task = tasks.find((t) => t.taskId === event.active.id);
    setDraggingTask(task ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingTask(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as string;
    const newStatus = over.id as TaskStatus;

    const task = tasks.find((t) => t.taskId === taskId);
    if (!task || task.status === newStatus) return;

    // Optimistic update
    setTasks((prev) => prev.map((t) => t.taskId === taskId ? { ...t, status: newStatus, completedAt: newStatus === 'done' ? new Date().toISOString() : undefined } : t));

    fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
      .then((r) => r.json())
      .then((d: { task: Task }) => {
        setTasks((prev) => prev.map((t) => t.taskId === taskId ? d.task : t));
      })
      .catch(() => {
        // Rollback on failure
        setTasks((prev) => prev.map((t) => t.taskId === taskId ? task : t));
      });
  }

  const handleUpdated = useCallback((updated: Task) => {
    setTasks((prev) => prev.map((t) => t.taskId === updated.taskId ? updated : t));
  }, []);

  const handleDeleted = useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.taskId !== taskId));
    setSelectedTaskId(null);
  }, []);

  const handleCreated = useCallback((task: Task) => {
    setTasks((prev) => [task, ...prev]);
    setCommentCounts((prev) => ({ ...prev, [task.taskId]: 0 }));
  }, []);

  function openNewTask(status: TaskStatus) {
    setNewTaskStatus(status);
    setShowNewTask(true);
  }

  // Unique projects for filter
  const projectOptions = allProjects.filter((p) => tasks.some((t) => t.projectId === p.projectId));

  const hasPanel = selectedTask !== null;

  return (
    <div className={`task-board${hasPanel ? ' task-board--with-panel' : ''}`}>
      {/* Board area */}
      <div className="task-board-main">
        {/* Filter bar */}
        <div className="task-board-toolbar">
          <select
            className="task-filter-select"
            value={filterProject}
            onChange={(e) => setFilterProject(e.target.value)}
          >
            <option value="">All Projects</option>
            {projectOptions.map((p) => (
              <option key={p.projectId} value={p.projectId}>{p.clientName} — {p.name}</option>
            ))}
          </select>
          <select
            className="task-filter-select"
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
          >
            <option value="">All Priorities</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <button
            type="button"
            className="task-board-add-btn"
            onClick={() => openNewTask('not_started')}
          >
            + New Task
          </button>
        </div>

        {/* Kanban columns */}
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="task-board-columns">
            {STATUS_ORDER.map((status) => (
              <TaskColumn
                key={status}
                status={status}
                tasks={byStatus(status)}
                users={users}
                commentCounts={commentCounts}
                selectedTaskId={selectedTaskId}
                collapsed={status === 'done' ? doneCollapsed : false}
                onToggleCollapse={() => setDoneCollapsed((v) => !v)}
                onSelectTask={(id) => setSelectedTaskId((prev) => prev === id ? null : id)}
                onAddTask={() => openNewTask(status)}
              />
            ))}
          </div>

          <DragOverlay>
            {draggingTask && (
              <TaskCard
                task={draggingTask}
                users={users}
                commentCount={commentCounts[draggingTask.taskId] ?? 0}
                selected={false}
                onClick={() => {}}
              />
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Side panel */}
      {selectedTask && (
        <TaskSidePanel
          task={selectedTask}
          allProjects={allProjects}
          users={users}
          currentUserId={currentUserId}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      {/* New task modal */}
      {showNewTask && (
        <NewTaskModal
          projects={allProjects}
          users={users}
          currentUserId={currentUserId}
          defaultStatus={newTaskStatus}
          onCreated={handleCreated}
          onClose={() => setShowNewTask(false)}
        />
      )}
    </div>
  );
}
