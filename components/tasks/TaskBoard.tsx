'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
import { TASK_TYPE_CONFIGS, resolveTaskTypeConfig, isTerminalStatus } from '@/lib/models/task-phase';
import type { Project } from '@/lib/models/project';
import type { UserSummary } from '@/lib/models/user';
import { TaskColumn } from './TaskColumn';
import { TaskCard } from './TaskCard';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskContextMenu } from './TaskContextMenu';
import { PlatformListView } from './PlatformListView';
import { TaskCalendarView, calendarDefaultVisible } from './TaskCalendarView';
import { PreprodColumnEditorModal } from './PreprodColumnEditorModal';
import { NewTaskModal } from '@/components/dashboard/NewTaskModal';
import { useTaskBroadcasts } from '@/hooks/useTaskBroadcasts';
import { usePreprodConfig } from '@/components/dashboard/preprod-config-context';

interface Props {
  initialTasks: Task[];
  allProjects: Project[];
  users: UserSummary[];
  currentUserId: string;
  commentCounts: Record<string, number>;
}

export function TaskBoard({ initialTasks, allProjects, users, currentUserId, commentCounts: initialCommentCounts }: Readonly<Props>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { statuses: preprodStatuses, canEditColumns: canEditPreprodCols } = usePreprodConfig();
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>(initialCommentCounts);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingTask, setDraggingTask] = useState<Task | null>(null);
  const [doneCollapsed, setDoneCollapsed] = useState(false);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showColumnEditor, setShowColumnEditor] = useState(false);
  // Defaults to Editing (not Pre-Production) since fresh preprod is empty —
  // landing on a blank board is a worse first-paint than landing on tasks.
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
  // Editing-only: kanban board vs scheduling calendar. Same persistence pattern as
  // platformView above — restored from localStorage in the effect further down.
  const [editingView, setEditingView] = useState<'board' | 'calendar'>('board');
  // Calendar-only: paint bars with their status colour, or all-neutral so the grid
  // reads purely as who-is-busy-when.
  const [calendarColor, setCalendarColor] = useState(true);
  // Set when the calendar opens the New Task modal from a specific day.
  const [newTaskDate, setNewTaskDate] = useState<string | null>(null);
  // Per-date exceptions to the default working week, shared by everyone —
  // a skipped holiday or an opened-up Saturday is a fact about the studio,
  // not about one person's view.
  const [dayOverrides, setDayOverrides] = useState<Record<string, boolean>>({});
  const [viewScope, setViewScope] = useState<'mine' | 'others' | 'all'>('mine');
  const [scopeLoading, setScopeLoading] = useState(false);
  const [phaseAnimKey, setPhaseAnimKey] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // A clicked task notification deep-links here with ?task=<id>. We stash the id until
  // the task is actually in state (the scope=all refetch may still be loading a task
  // the current user doesn't own), then the resolve effect opens it.
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  // Guards the persist effect from clobbering stored prefs with defaults before the
  // restore effect has run (mirrors ProjectsPageClient).
  const didRestoreRef = useRef(false);

  // Retain the user's last tab (Editing/Platform) and scope (Mine/Others/All) across
  // sessions, mirroring the platformView persistence above. localStorage-only (no URL)
  // so it never collides with the ?task= deep-link param. SSR-safe: the initial render
  // uses the static defaults; stored values apply post-hydration.
  useEffect(() => {
    try {
      const t = window.localStorage.getItem('lpos:tasks:taskType');
      if (t === 'preprod' || t === 'editing' || t === 'platform') setActiveTaskType(t);
      const s = window.localStorage.getItem('lpos:tasks:scope');
      if (s === 'mine' || s === 'others' || s === 'all') setViewScope(s);
      const ev = window.localStorage.getItem('lpos:tasks:editingView');
      if (ev === 'board' || ev === 'calendar') setEditingView(ev);
      const cc = window.localStorage.getItem('lpos:tasks:calendarColor');
      if (cc === '0' || cc === '1') setCalendarColor(cc === '1');
    } catch { /* localStorage may be blocked */ }
    didRestoreRef.current = true;
  }, []);
  useEffect(() => {
    if (!didRestoreRef.current) return;
    try {
      window.localStorage.setItem('lpos:tasks:taskType', activeTaskType);
      window.localStorage.setItem('lpos:tasks:scope', viewScope);
      window.localStorage.setItem('lpos:tasks:editingView', editingView);
      window.localStorage.setItem('lpos:tasks:calendarColor', calendarColor ? '1' : '0');
    } catch { /* ignore */ }
  }, [activeTaskType, viewScope, editingView, calendarColor]);

  // Deep-link in: read ?task= via useSearchParams (not a one-shot window.location read)
  // so it also fires when we're *already* on /dashboard and the param arrives via a soft
  // navigation. Stash the id and clean the URL; the resolve effect below does the rest.
  const deepLinkTaskId = searchParams.get('task');
  useEffect(() => {
    if (!deepLinkTaskId) return;
    setPendingTaskId(deepLinkTaskId);
    router.replace('/dashboard', { scroll: false } as Parameters<typeof router.replace>[1]);
  }, [deepLinkTaskId, router]);

  // Resolve a pending deep-link once its task is loaded: switch to the task's tab, widen
  // the scope if the task wouldn't otherwise be visible, open the detail modal, and
  // highlight the card so it's framed once the modal is closed.
  useEffect(() => {
    if (!pendingTaskId) return;
    const task = tasks.find((t) => t.taskId === pendingTaskId);
    if (!task) return; // wait for the scope=all refetch to bring it in
    if (task.taskType !== activeTaskType) {
      setActiveTaskType(task.taskType);
      setPhaseAnimKey((k) => k + 1);
      setDoneCollapsed(true);
    }
    const visibleUnderScope =
      viewScope === 'all' ||
      (viewScope === 'mine'   &&  task.assignedTo.includes(currentUserId)) ||
      (viewScope === 'others' && !task.assignedTo.includes(currentUserId));
    if (!visibleUnderScope) setViewScope('all');
    setSelectedTaskId(task.taskId);
    setHighlightedId(task.taskId);
    setPendingTaskId(null);
  }, [pendingTaskId, tasks, activeTaskType, viewScope, currentUserId]);

  useEffect(() => {
    if (!highlightedId) return;
    const scrollTimer = setTimeout(() => {
      document.querySelector(`[data-task-id="${highlightedId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    const clearTimer = setTimeout(() => setHighlightedId(null), 1800);
    return () => { clearTimeout(scrollTimer); clearTimeout(clearTimer); };
  }, [highlightedId]);

  // Refetch task list on scope change. Both 'mine' and 'others' need the full task list
  // to filter client-side; we always fetch scope=all from the server and filter in render.
  // The first run refetches redundantly with initialTasks — cheap, keeps state canonical.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setScopeLoading(true);
      try {
        const res = await fetch('/api/tasks?scope=all');
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

  // Working-day overrides. Fetched once — the table holds one row per exception,
  // so it is a few dozen rows at most.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/calendar-days');
        if (!res.ok) return;
        const data = await res.json() as { overrides?: Array<{ date: string; working: boolean }> };
        if (cancelled) return;
        const map: Record<string, boolean> = {};
        for (const o of data.overrides ?? []) map[o.date] = o.working;
        setDayOverrides(map);
      } catch { /* calendar falls back to the default Mon-Fri pattern */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSetDayWorking = useCallback((date: string, working: boolean | null) => {
    // Roll back only THIS date on failure, not the whole map — broadcasts from
    // other users mutate it concurrently, and restoring a whole snapshot would
    // undo their changes too.
    const prevValue = dayOverrides[date];
    setDayOverrides((cur) => {
      const next = { ...cur };
      if (working === null) delete next[date]; else next[date] = working;
      return next;
    });
    const req = working === null
      ? fetch(`/api/calendar-days?date=${encodeURIComponent(date)}`, { method: 'DELETE' })
      : fetch('/api/calendar-days', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, working }),
      });
    req.then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch((err: Error) => {
        setDayOverrides((cur) => {
          const next = { ...cur };
          if (prevValue === undefined) delete next[date]; else next[date] = prevValue;
          return next;
        });
        setDragError(`Failed to update that day: ${err.message}`);
      });
  }, [dayOverrides]);

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
  // For Pre-Production the column list is dynamic — merge live statuses from
  // PreprodConfigContext. Editing / Platform fall through to the static config.
  const taskTypeConfig = resolveTaskTypeConfig(activeTaskType, preprodStatuses);
  const isEmptyPreprod = activeTaskType === 'preprod' && taskTypeConfig.statuses.length === 0;

  // Filtered tasks: scope (mine/others) + active task type
  const visibleTasks = tasks.filter((t) => {
    if (t.taskType !== activeTaskType) return false;
    if (viewScope === 'mine')   return  t.assignedTo.includes(currentUserId);
    if (viewScope === 'others') return !t.assignedTo.includes(currentUserId);
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
    const dragConfig = resolveTaskTypeConfig(task.taskType, preprodStatuses);
    const validStatuses = new Set(dragConfig.statuses.map((s) => s.value));
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
  // Someone else skipping a holiday has to reach every open board — otherwise
  // two people plan against different working weeks. Idempotent: applying an
  // override we already hold is a no-op, so our own echo is harmless.
  const onBroadcastCalendarDay = useCallback((date: string, working: boolean | null) => {
    setDayOverrides((cur) => {
      const next = { ...cur };
      if (working === null) delete next[date]; else next[date] = working;
      return next;
    });
  }, []);
  useTaskBroadcasts({
    onCreated: onBroadcastCreated,
    onUpdated: onBroadcastUpdated,
    onDeleted: onBroadcastDeleted,
    onCalendarDay: onBroadcastCalendarDay,
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
      setViewScope('others');
    }
  }, [activeTaskType, viewScope, currentUserId, upsertTask]);

  function handleCardContextMenu(e: React.MouseEvent, taskId: string) {
    e.preventDefault();
    setContextMenu({ taskId, x: e.clientX, y: e.clientY });
  }

  async function handleCategoryChange(taskId: string, newCategory: string) {
    const task = tasks.find((t) => t.taskId === taskId);
    if (!task) return;
    setTasks((prev) => prev.map((t) => t.taskId === taskId ? { ...t, category: newCategory } : t));
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: newCategory }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { task: Task };
      setTasks((prev) => prev.map((t) => t.taskId === taskId ? data.task : t));
    } catch (err) {
      setTasks((prev) => prev.map((t) => t.taskId === taskId ? task : t));
      setDragError(`Failed to move task: ${(err as Error).message}`);
    }
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

  /**
   * Calendar drop: write the new span optimistically, then PATCH. Mirrors
   * handleDragEnd's rollback-on-failure so a dropped bar never lies about where
   * it landed. Passing start=null unplans the task back to the rail.
   */
  const handleSchedule = useCallback((taskId: string, start: string | null, end: string | null, order: number) => {
    const prevTask = tasks.find((t) => t.taskId === taskId);
    if (!prevTask) return;

    setTasks((prev) => prev.map((t) => t.taskId === taskId
      ? { ...t, scheduledStart: start, scheduledEnd: start ? (end ?? start) : null, scheduleOrder: order }
      : t));

    fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledStart: start, scheduledEnd: end, scheduleOrder: order }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ task: Task }>;
      })
      .then((d) => setTasks((prev) => prev.map((t) => t.taskId === taskId ? d.task : t)))
      .catch((err: Error) => {
        setTasks((prev) => prev.map((t) => t.taskId === taskId ? prevTask : t));
        setDragError(`Failed to reschedule: ${err.message}`);
      });
  }, [tasks]);

  async function handleContextStatus(taskId: string, status: string) {
    const prevTask = tasks.find((t) => t.taskId === taskId);
    if (!prevTask) return;
    setTasks((prev) => prev.map((t) => t.taskId === taskId
      ? { ...t, status, completedAt: isTerminalStatus(t.taskType, status) ? new Date().toISOString() : undefined }
      : t));
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { task: Task };
      setTasks((prev) => prev.map((t) => t.taskId === taskId ? data.task : t));
    } catch (err) {
      setTasks((prev) => prev.map((t) => t.taskId === taskId ? prevTask : t));
      setDragError(`Failed to change status: ${(err as Error).message}`);
    }
  }

  /** Per-task calendar visibility override. `null` returns it to the default
   *  rule (Done and In Review hidden). */
  async function handleContextCalendarVisible(taskId: string, value: boolean | null) {
    const prevTask = tasks.find((t) => t.taskId === taskId);
    if (!prevTask) return;
    setTasks((prev) => prev.map((t) => t.taskId === taskId ? { ...t, calendarVisible: value } : t));
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarVisible: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { task: Task };
      setTasks((prev) => prev.map((t) => t.taskId === taskId ? data.task : t));
    } catch (err) {
      setTasks((prev) => prev.map((t) => t.taskId === taskId ? prevTask : t));
      setDragError(`Failed to update calendar visibility: ${(err as Error).message}`);
    }
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

        {/* Control cluster — pinned right, fixed slot order: scope -> view ->
            action. Both slots hold their width when a tab has nothing to put in
            them, so switching tabs never reflows the row. */}
        <div className="task-toolbar-cluster">
          {/* Mine / Others / All toggle */}
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
              className={`task-scope-btn${viewScope === 'others' ? ' task-scope-btn--active' : ''}`}
              onClick={() => setViewScope('others')}
            >
              Others
            </button>
            <button
              type="button"
              className={`task-scope-btn${viewScope === 'all' ? ' task-scope-btn--active' : ''}`}
              onClick={() => setViewScope('all')}
            >
              All
            </button>
          </div>

          {/* View slot. The three-bar glyph means "board" on Editing and
              "kanban" on Platform — it is the same icon, so it sits FIRST in
              both toggles. Putting it second in one of them made it appear to
              jump sides when switching tabs. Pre-Production has no second view
              and leaves the slot empty, at width. */}
          <div className="task-toolbar-slot task-toolbar-slot--view">
            {activeTaskType === 'editing' && (
              <div className="task-view-toggle" role="tablist" aria-label="View">
                <button
                  type="button"
                  className={`task-view-btn${editingView === 'board' ? ' task-view-btn--active' : ''}`}
                  onClick={() => setEditingView('board')}
                  title="Board view — grouped by status"
                  aria-label="Board view"
                  aria-pressed={editingView === 'board'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3"  y="4" width="5" height="16" rx="1"/>
                    <rect x="10" y="4" width="5" height="10" rx="1"/>
                    <rect x="17" y="4" width="4" height="13" rx="1"/>
                  </svg>
                </button>
                <button
                  type="button"
                  className={`task-view-btn${editingView === 'calendar' ? ' task-view-btn--active' : ''}`}
                  onClick={() => setEditingView('calendar')}
                  title="Calendar view — which days each editor is working on what"
                  aria-label="Calendar view"
                  aria-pressed={editingView === 'calendar'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="18" rx="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
                  </svg>
                </button>
              </div>
            )}

            {activeTaskType === 'platform' && (
              <div className="task-view-toggle" role="tablist" aria-label="View">
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
              </div>
            )}
          </div>

          {/* Action slot. Editing used to have no toolbar entry at all, relying
              on the Not Started column's "+" — which the calendar view doesn't
              have, leaving no discoverable way to add a task there. */}
          <div className="task-toolbar-slot task-toolbar-slot--action">
            {activeTaskType === 'preprod' ? (
              canEditPreprodCols && (
                <button
                  type="button"
                  className="task-board-add-btn"
                  onClick={() => setShowColumnEditor(true)}
                  title="Add, rename, recolor, reorder, or delete columns on the Pre-Production board."
                >
                  Manage columns
                </button>
              )
            ) : (
              <button
                type="button"
                className="task-board-add-btn"
                onClick={() => setShowNewTask(true)}
              >
                + New Task
              </button>
            )}
          </div>
        </div>
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
      {isEmptyPreprod ? (
        <div
          style={{
            padding: '48px 24px',
            textAlign: 'center',
            opacity: 0.75,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <p style={{ margin: 0, fontSize: '0.95rem' }}>
            No Pre-Production columns yet.
          </p>
          {canEditPreprodCols ? (
            <button
              type="button"
              className="task-board-add-btn"
              onClick={() => setShowColumnEditor(true)}
            >
              Set up columns
            </button>
          ) : (
            <p style={{ margin: 0, fontSize: '0.8rem', opacity: 0.7 }}>
              Ask an admin to set up columns for this board.
            </p>
          )}
        </div>
      ) : activeTaskType === 'editing' && editingView === 'calendar' ? (
        <TaskCalendarView
          tasks={visibleTasks}
          users={users}
          statuses={taskTypeConfig.statuses}
          colorByStatus={calendarColor}
          onToggleColor={() => setCalendarColor((v) => !v)}
          selectedTaskId={selectedTaskId}
          highlightTaskId={highlightedId}
          renamingTaskId={renamingTaskId}
          onSelectTask={(id) => setSelectedTaskId((prev) => prev === id ? null : id)}
          onCardContextMenu={handleCardContextMenu}
          onSchedule={handleSchedule}
          onRenameCommit={handleRenameCommit}
          onRenameCancel={() => setRenamingTaskId(null)}
          onNewTaskOnDay={(date) => { setNewTaskDate(date); setShowNewTask(true); }}
          dayOverrides={dayOverrides}
          onSetDayWorking={handleSetDayWorking}
        />
      ) : activeTaskType === 'platform' && platformView === 'list' ? (
        <PlatformListView
          tasks={visibleTasks}
          users={users}
          highlightTaskId={highlightedId}
          onSelectTask={(id) => setSelectedTaskId((prev) => prev === id ? null : id)}
          onCardContextMenu={handleCardContextMenu}
          onCategoryChange={(taskId, cat) => void handleCategoryChange(taskId, cat)}
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
                highlightTaskId={highlightedId}
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
        // The calendar has no status columns to drag between, and it can plan or
        // unplan — so it gets three extra items the board doesn't need.
        const onCalendar = activeTaskType === 'editing' && editingView === 'calendar';
        return (
          <TaskContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            taskId={contextMenu.taskId}
            assignedTo={ctxTask.assignedTo}
            users={users}
            statuses={onCalendar ? taskTypeConfig.statuses : undefined}
            currentStatus={onCalendar ? ctxTask.status : undefined}
            onStatusChange={onCalendar ? (s) => void handleContextStatus(contextMenu.taskId, s) : undefined}
            onUnplan={onCalendar && ctxTask.scheduledStart
              ? () => handleSchedule(contextMenu.taskId, null, null, 0)
              : undefined}
            onPlanToday={onCalendar && !ctxTask.scheduledStart
              ? () => {
                const n = new Date();
                const d = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
                handleSchedule(contextMenu.taskId, d, d, 0);
              }
              : undefined}
            calendarShown={activeTaskType === 'editing'
              ? (ctxTask.calendarVisible ?? calendarDefaultVisible(ctxTask))
              : undefined}
            calendarDefaultShown={activeTaskType === 'editing' ? calendarDefaultVisible(ctxTask) : undefined}
            // Offered on the board too, not just the calendar: a task hidden
            // from the calendar can only be un-hidden somewhere it still shows.
            onSetCalendarVisible={activeTaskType === 'editing'
              ? (v) => void handleContextCalendarVisible(contextMenu.taskId, v)
              : undefined}
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
          defaultScheduledDate={newTaskDate ?? undefined}
          onCreated={handleCreated}
          onClose={() => { setShowNewTask(false); setNewTaskDate(null); }}
        />
      )}

      {/* Pre-Production column editor */}
      {showColumnEditor && (
        <PreprodColumnEditorModal onClose={() => setShowColumnEditor(false)} />
      )}
    </div>
  );
}
