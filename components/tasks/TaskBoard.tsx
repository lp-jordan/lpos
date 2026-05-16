'use client';

import { useCallback, useEffect, useState } from 'react';
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
import type { TaskType } from '@/lib/models/task-phase';
import { TASK_TYPE_CONFIGS, getTaskTypeConfig, isTerminalStatus } from '@/lib/models/task-phase';
import type { Project } from '@/lib/models/project';
import type { UserSummary } from '@/lib/models/user';
import { TaskColumn } from './TaskColumn';
import { TaskCard } from './TaskCard';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskContextMenu } from './TaskContextMenu';
import { PlatformListView } from './PlatformListView';
import { NewTaskModal } from '@/components/dashboard/NewTaskModal';
import { useTaskBroadcasts } from '@/hooks/useTaskBroadcasts';

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
  const [activeTaskType, setActiveTaskType] = useState<TaskType>('editing');
  // Platform-only view preference: list (grouped by category) vs kanban (12 status cols).
  // Persisted in localStorage so each user's choice survives across sessions. SSR-safe
  // initial value of 'list' (the F4 default); the actual stored value reads in the
  // effect below since localStorage is browser-only.
  const [platformView, setPlatformView] = useState<'list' | 'kanban'>('list');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('lpos:tasks:platformView');
      if (stored === 'kanban' || stored === 'list') setPlatformView(stored);
    } catch { /* localStorage may be blocked */ }
  }, []);
  function changePlatformView(next: 'list' | 'kanban') {
    setPlatformView(next);
    try { window.localStorage.setItem('lpos:tasks:platformView', next); } catch { /* ignore */ }
  }
  const [viewScope, setViewScope] = useState<'mine' | 'all'>('mine');
  const [scopeLoading, setScopeLoading] = useState(false);
  const [phaseAnimKey, setPhaseAnimKey] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);

  // Refetch task list whenever the Mine/All scope changes. 'mine' returns only tasks
  // the current user created or is assigned to; 'all' returns every task in the system.
  // The first run refetches 'mine' redundantly with initialTasks — cheap, keeps state
  // canonical against the server if the page has been open for a while.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setScopeLoading(true);
      try {
        const res = await fetch(`/api/tasks${viewScope === 'all' ? '?scope=all' : ''}`);
        if (!res.ok) throw new Error(`Failed to load tasks (${res.status})`);
        const data = await res.json() as { tasks: Task[] };
        if (!cancelled) setTasks(data.tasks);
      } catch (err) {
        if (!cancelled) setDragError((err as Error).message);
      } finally {
        if (!cancelled) setScopeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [viewScope]);

  // Auto-clear the error banner so a transient drag failure doesn't stick on screen.
  useEffect(() => {
    if (!dragError) return;
    const t = setTimeout(() => setDragError(null), 5000);
    return () => clearTimeout(t);
  }, [dragError]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const selectedTask = tasks.find((t) => t.taskId === selectedTaskId) ?? null;
  const taskTypeConfig = getTaskTypeConfig(activeTaskType);

  // Filtered tasks: scope (mine/all) + active task type
  const visibleTasks = tasks.filter((t) => {
    if (t.taskType !== activeTaskType) return false;
    if (viewScope === 'mine') {
      return t.assignedTo.includes(currentUserId);
    }
    return true;
  });

  const byStatus = (status: string) => visibleTasks.filter((t) => t.status === status);

  function switchTaskType(taskType: TaskType) {
    if (taskType === activeTaskType) return;
    setActiveTaskType(taskType);
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

    // Validate the resolved status against the task's task-type config. If the drop
    // landed on something that isn't a status column for this task type (and isn't
    // another card we could resolve), reject the drop entirely — don't corrupt
    // the task's status by sending a garbage value to the server.
    const validStatuses = new Set(getTaskTypeConfig(task.taskType).statuses.map((s) => s.value));
    if (!validStatuses.has(newStatus)) {
      setDragError(`Invalid drop target — that's not a status column for ${task.taskType}.`);
      return;
    }

    setTasks((prev) => prev.map((t) =>
      t.taskId === taskId
        ? { ...t, status: newStatus, completedAt: isTerminalStatus(task.taskType, newStatus) ? new Date().toISOString() : undefined }
        : t,
    ));

    fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
      .then(async (r) => {
        if (!r.ok) {
          let msg = `HTTP ${r.status}`;
          try {
            const body = await r.json() as { error?: string };
            if (body.error) msg = body.error;
          } catch { /* not JSON */ }
          throw new Error(msg);
        }
        return r.json() as Promise<{ task: Task }>;
      })
      .then((d) => {
        setTasks((prev) => prev.map((t) => t.taskId === taskId ? d.task : t));
      })
      .catch((err: Error) => {
        // Roll back optimistic update + surface the error so the user knows
        // the change didn't stick (previously this was silently swallowed).
        setTasks((prev) => prev.map((t) => t.taskId === taskId ? task : t));
        setDragError(`Failed to move task: ${err.message}`);
      });
  }

  const handleUpdated = useCallback((updated: Task) => {
    setTasks((prev) => prev.map((t) => t.taskId === updated.taskId ? updated : t));
  }, []);

  const handleDeleted = useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.taskId !== taskId));
    setSelectedTaskId(null);
  }, []);

  // Idempotent upsert used by both the local create handler and the socket broadcast.
  const upsertTask = useCallback((task: Task) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.taskId === task.taskId);
      if (idx === -1) return [task, ...prev];
      const next = prev.slice();
      next[idx] = task;
      return next;
    });
    setCommentCounts((prev) => (task.taskId in prev ? prev : { ...prev, [task.taskId]: 0 }));
  }, []);

  // Live socket broadcasts: any task mutation from any user reaches us here.
  // Handlers are intentionally simple — render-time filter (visibleTasks) decides
  // whether the task is actually shown under the current viewScope.
  const onBroadcastCreated = useCallback((task: Task) => { upsertTask(task); }, [upsertTask]);
  const onBroadcastUpdated = useCallback((task: Task) => { upsertTask(task); }, [upsertTask]);
  const onBroadcastDeleted = useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.taskId !== taskId));
    setSelectedTaskId((cur) => cur === taskId ? null : cur);
  }, []);
  useTaskBroadcasts({
    onCreated: onBroadcastCreated,
    onUpdated: onBroadcastUpdated,
    onDeleted: onBroadcastDeleted,
  });

  const handleCreated = useCallback((task: Task) => {
    upsertTask(task);
    // If the new task wouldn't be visible under the current view, auto-switch so
    // the user can see what they just created. Two reasons it could be hidden:
    //  - taskType mismatch: user changed the type in the modal away from active
    //  - mine-filter mismatch: user unchecked themselves from assignees
    if (task.taskType !== activeTaskType) {
      setActiveTaskType(task.taskType);
      setPhaseAnimKey((k) => k + 1);
      setDoneCollapsed(true);
    }
    if (viewScope === 'mine' && !task.assignedTo.includes(currentUserId)) {
      setViewScope('all');
    }
  }, [activeTaskType, viewScope, currentUserId, upsertTask]);

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
        {/* Task type tabs */}
        <div className="task-phase-tabs">
          {TASK_TYPE_CONFIGS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`task-phase-tab${activeTaskType === c.value ? ' task-phase-tab--active' : ''}`}
              onClick={() => switchTaskType(c.value)}
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

        {/* List / Kanban view toggle — Platform only. Editing is kanban-only by design. */}
        {activeTaskType === 'platform' && (
          <div className="task-view-toggle" role="tablist" aria-label="View">
            <button
              type="button"
              className={`task-view-btn${platformView === 'list' ? ' task-view-btn--active' : ''}`}
              onClick={() => changePlatformView('list')}
              title="List view — grouped by category"
              aria-label="List view"
              aria-pressed={platformView === 'list'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="8" y1="6" x2="21" y2="6"/>
                <line x1="8" y1="12" x2="21" y2="12"/>
                <line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/>
                <line x1="3" y1="12" x2="3.01" y2="12"/>
                <line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
            </button>
            <button
              type="button"
              className={`task-view-btn${platformView === 'kanban' ? ' task-view-btn--active' : ''}`}
              onClick={() => changePlatformView('kanban')}
              title="Kanban view — grouped by status"
              aria-label="Kanban view"
              aria-pressed={platformView === 'kanban'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3"  y="4" width="5" height="16" rx="1"/>
                <rect x="10" y="4" width="5" height="10" rx="1"/>
                <rect x="17" y="4" width="4" height="13" rx="1"/>
              </svg>
            </button>
          </div>
        )}

        {/* Editing has its own column-level "+" in the Not Started column;
            the toolbar button is hidden there to avoid two entry points.
            Platform's kanban statuses don't map to a single starting point
            cleanly, so it keeps the toolbar button as the canonical add. */}
        {activeTaskType !== 'editing' && (
          <button
            type="button"
            className="task-board-add-btn"
            onClick={() => setShowNewTask(true)}
          >
            + New Task
          </button>
        )}
      </div>

      {/* Transient error banner (drag failures, scope-refetch failures) */}
      {dragError && (
        <div
          className="task-board-error-banner"
          role="alert"
          style={{
            padding: '6px 12px',
            margin: '4px 0',
            borderRadius: 4,
            background: 'rgba(224,112,106,0.12)',
            color: '#e07070',
            fontSize: '0.85rem',
          }}
        >
          {dragError}
        </div>
      )}

      {/* Body — three render paths:
            • Platform + list (default for Platform): grouped table from F4
            • Platform + kanban: 12-column status board, same kanban code as Editing
            • Editing: always kanban (no toggle, no other option)
          The kanban branch is shared between Editing and Platform — taskTypeConfig
          already drives column statuses from the active task type. */}
      {activeTaskType === 'platform' && platformView === 'list' ? (
        <PlatformListView
          tasks={visibleTasks}
          users={users}
          onSelectTask={(id) => setSelectedTaskId((prev) => prev === id ? null : id)}
          onCardContextMenu={handleCardContextMenu}
        />
      ) : (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div key={phaseAnimKey} className="task-board-columns task-board-columns--anim">
            {taskTypeConfig.statuses.map((s) => (
              <TaskColumn
                key={s.value}
                status={s.value}
                label={s.label}
                color={s.color}
                isTerminal={s.value === taskTypeConfig.terminalStatus}
                // Column "+" is narrowed to the defaultStatus ("Not Started") column
                // only — other non-terminal columns no longer offer their own add button.
                // Platform also keeps the toolbar button above; Editing relies solely
                // on this column-level "+".
                showAddButton={s.value === taskTypeConfig.defaultStatus}
                tasks={byStatus(s.value)}
                users={users}
                commentCounts={commentCounts}
                selectedTaskId={selectedTaskId}
                renamingTaskId={renamingTaskId}
                collapsed={s.value === taskTypeConfig.terminalStatus ? doneCollapsed : false}
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
      )}

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
          users={users}
          clientNames={Array.from(new Set(allProjects.map((p) => p.clientName).filter(Boolean)))}
          currentUserId={currentUserId}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      {/* New task modal */}
      {showNewTask && (
        <NewTaskModal
          clientNames={Array.from(new Set(allProjects.map((p) => p.clientName).filter(Boolean)))}
          users={users}
          currentUserId={currentUserId}
          taskType={activeTaskType}
          onCreated={handleCreated}
          onClose={() => setShowNewTask(false)}
        />
      )}
    </div>
  );
}
