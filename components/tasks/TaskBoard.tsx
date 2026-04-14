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
import type { Task } from '@/lib/models/task';
import type { TaskPhase } from '@/lib/models/task-phase';
import { PHASE_CONFIGS, getPhaseConfig, isTerminalStatus } from '@/lib/models/task-phase';
import type { Project } from '@/lib/models/project';
import type { UserSummary } from '@/lib/models/user';
import { TaskColumn } from './TaskColumn';
import { TaskCard } from './TaskCard';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskContextMenu } from './TaskContextMenu';
import { NewTaskModal } from '@/components/dashboard/NewTaskModal';

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
  const [doneCollapsed, setDoneCollapsed] = useState(false);
  const [showNewTask, setShowNewTask] = useState(false);
  const [activePhase, setActivePhase] = useState<TaskPhase>('pre_production');
  const [viewScope, setViewScope] = useState<'mine' | 'all'>('mine');
  const [phaseAnimKey, setPhaseAnimKey] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const selectedTask = tasks.find((t) => t.taskId === selectedTaskId) ?? null;
  const phaseConfig = getPhaseConfig(activePhase);

  const projectsMap: Record<string, string> = Object.fromEntries(
    allProjects.map((p) => [p.projectId, p.name]),
  );

  // Filtered tasks: scope (mine/all) + active phase
  const visibleTasks = tasks.filter((t) => {
    if (t.phase !== activePhase) return false;
    if (viewScope === 'mine') {
      return t.assignedTo.includes(currentUserId);
    }
    return true;
  });

  const byStatus = (status: string) => visibleTasks.filter((t) => t.status === status);

  function switchPhase(phase: TaskPhase) {
    if (phase === activePhase) return;
    setActivePhase(phase);
    setPhaseAnimKey((k) => k + 1);
    setDoneCollapsed(true);
    setSelectedTaskId(null);
  }

  function handleDragStart(event: DragStartEvent) {
    const task = tasks.find((t) => t.taskId === event.active.id);
    setDraggingTask(task ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingTask(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as string;
    // over.id may be a column status string OR another card's taskId (imprecise drop).
    // If it's a card, resolve to that card's current status.
    const overId = over.id as string;
    const overTask = tasks.find((t) => t.taskId === overId);
    const newStatus = overTask ? overTask.status : overId;

    const task = tasks.find((t) => t.taskId === taskId);
    if (!task || task.status === newStatus) return;

    setTasks((prev) => prev.map((t) =>
      t.taskId === taskId
        ? { ...t, status: newStatus, completedAt: isTerminalStatus(task.phase, newStatus) ? new Date().toISOString() : undefined }
        : t,
    ));

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

  function handleCardContextMenu(e: React.MouseEvent, taskId: string) {
    e.preventDefault();
    setContextMenu({ taskId, x: e.clientX, y: e.clientY });
  }

  async function handleRenameCommit(taskId: string, title: string) {
    setRenamingTaskId(null);
    setTasks((prev) => prev.map((t) => t.taskId === taskId ? { ...t, description: title } : t));
    await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: title }),
    });
  }

  async function handleContextReassign(taskId: string, userIds: string[]) {
    setTasks((prev) => prev.map((t) => t.taskId === taskId ? { ...t, assignedTo: userIds } : t));
    await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: userIds }),
    });
  }

  async function handleContextDelete(taskId: string) {
    setTasks((prev) => prev.filter((t) => t.taskId !== taskId));
    setSelectedTaskId(null);
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
  }

  return (
    <div className="task-board">
      {/* Toolbar */}
      <div className="task-board-toolbar">
        {/* Phase tabs */}
        <div className="task-phase-tabs">
          {PHASE_CONFIGS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`task-phase-tab${activePhase === c.value ? ' task-phase-tab--active' : ''}`}
              onClick={() => switchPhase(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Mine / All toggle */}
        <div className="task-scope-toggle">
          <button
            type="button"
            className={`task-scope-btn${viewScope === 'mine' ? ' task-scope-btn--active' : ''}`}
            onClick={() => setViewScope('mine')}
          >
            Mine
          </button>
          <button
            type="button"
            className={`task-scope-btn${viewScope === 'all' ? ' task-scope-btn--active' : ''}`}
            onClick={() => setViewScope('all')}
          >
            All
          </button>
        </div>

        <button
          type="button"
          className="task-board-add-btn"
          onClick={() => setShowNewTask(true)}
        >
          + New Task
        </button>
      </div>

      {/* Kanban */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div key={phaseAnimKey} className="task-board-columns task-board-columns--anim">
          {phaseConfig.statuses.map((s) => (
            <TaskColumn
              key={s.value}
              status={s.value}
              label={s.label}
              color={s.color}
              isTerminal={s.value === phaseConfig.terminalStatus}
              tasks={byStatus(s.value)}
              users={users}
              commentCounts={commentCounts}
              projectsMap={projectsMap}
              selectedTaskId={selectedTaskId}
              renamingTaskId={renamingTaskId}
              collapsed={s.value === phaseConfig.terminalStatus ? doneCollapsed : false}
              onToggleCollapse={() => setDoneCollapsed((v) => !v)}
              onSelectTask={(id) => setSelectedTaskId((prev) => prev === id ? null : id)}
              onAddTask={() => setShowNewTask(true)}
              onCardContextMenu={handleCardContextMenu}
              onRenameCommit={handleRenameCommit}
              onRenameCancel={() => setRenamingTaskId(null)}
            />
          ))}
        </div>

        <DragOverlay>
          {draggingTask && (
            <TaskCard
              task={draggingTask}
              users={users}
              commentCount={commentCounts[draggingTask.taskId] ?? 0}
              projectName={projectsMap[draggingTask.projectId] ?? null}
              selected={false}
              isRenaming={false}
              onClick={() => {}}
              onContextMenu={() => {}}
              onRenameCommit={() => {}}
              onRenameCancel={() => {}}
            />
          )}
        </DragOverlay>
      </DndContext>

      {/* Context menu */}
      {contextMenu && (() => {
        const ctxTask = tasks.find((t) => t.taskId === contextMenu.taskId);
        if (!ctxTask) return null;
        return (
          <TaskContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            taskId={contextMenu.taskId}
            assignedTo={ctxTask.assignedTo}
            users={users}
            onRename={() => setRenamingTaskId(contextMenu.taskId)}
            onReassign={(ids) => void handleContextReassign(contextMenu.taskId, ids)}
            onDelete={() => void handleContextDelete(contextMenu.taskId)}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

      {/* Task detail modal */}
      {selectedTask && (
        <TaskDetailModal
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
          defaultPhase={activePhase}
          onCreated={handleCreated}
          onClose={() => setShowNewTask(false)}
        />
      )}
    </div>
  );
}
