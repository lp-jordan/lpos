'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@/lib/models/task';
import type { TaskTypeStatus } from '@/lib/models/task-phase';
import { isTerminalStatus } from '@/lib/models/task-phase';
import type { UserSummary } from '@/lib/models/user';

/**
 * Month-grid scheduling view for Editing tasks.
 *
 * This is deliberately NOT a due-date system: a bar says "this is the day the
 * editor is working on this", nothing treats a past date as late, and no part of
 * the UI styles one differently for being behind.
 *
 * Why raw pointer events instead of @dnd-kit (which the kanban board uses): bars
 * span multiple day cells, resize from either edge, and wrap across week rows —
 * none of which map onto dnd-kit's droppable/sortable model. The gesture here is
 * "which day is under the cursor", which is geometry, not hit-registration.
 */

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Height of one stacked bar plus its gap, in px. */
const LANE_STEP = 32;
/** Gutter at the top of a week row reserved for the day numbers. Bars are
 *  absolutely positioned against the lane box's *padding edge*, so this has to be
 *  added to their `top` — CSS padding alone would not push them clear. */
const DAYNUM_H = 26;
/** Minimum lanes a week row reserves. Keeps row heights stable mid-drag, so the
 *  day under the cursor doesn't shift out from under the pointer. */
const MIN_LANES = 2;

// ── Date helpers ───────────────────────────────────────────────────────────
// Everything is an inclusive ISO day string. Dates are built at local noon so a
// DST shift can never tip a date across midnight into the neighbouring day.

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fromIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}
function addDays(d: Date, n: number): Date {
  const c = new Date(d.getTime());
  c.setDate(c.getDate() + n);
  return c;
}
/** Whole days from a to b; negative when b is earlier. */
function dayDiff(a: string, b: string): number {
  return Math.round((fromIso(b).getTime() - fromIso(a).getTime()) / 86_400_000);
}
function todayIso(): string {
  return toIso(new Date());
}
function fmtDay(s: string): string {
  const d = fromIso(s);
  return `${DOW_LABELS[(d.getDay() + 6) % 7]} ${d.getDate()}`;
}
function fmtRange(start: string, end: string): string {
  const ds = fromIso(start);
  const de = fromIso(end);
  if (start === end) return `${fmtDay(start)} ${MONTH_SHORT[ds.getMonth()]}`;
  if (ds.getMonth() === de.getMonth()) return `${fmtDay(start)} → ${fmtDay(end)} ${MONTH_SHORT[de.getMonth()]}`;
  return `${fmtDay(start)} ${MONTH_SHORT[ds.getMonth()]} → ${fmtDay(end)} ${MONTH_SHORT[de.getMonth()]}`;
}

// ── Lane packing ───────────────────────────────────────────────────────────

interface Segment {
  task: Task;
  /** Column 0-6 within this week where the bar starts. */
  col: number;
  /** How many columns it covers in this week. */
  span: number;
  /** True when the task began before this week / continues past it. */
  clipStart: boolean;
  clipEnd: boolean;
  lane: number;
}

/**
 * Clip every scheduled task to one week and stack the results. Manual
 * scheduleOrder wins; ties fall back to start day. Each segment drops into the
 * lowest lane it doesn't collide in, so a week uses as few rows as it can.
 */
function segmentsForWeek(weekStart: string, tasks: Task[]): Segment[] {
  const weekEnd = toIso(addDays(fromIso(weekStart), 6));

  const segs: Segment[] = tasks
    .filter((t) => {
      if (!t.scheduledStart || !t.scheduledEnd) return false;
      return !(dayDiff(weekStart, t.scheduledEnd) < 0 || dayDiff(t.scheduledStart, weekEnd) < 0);
    })
    .map((t) => {
      const rawStart = dayDiff(weekStart, t.scheduledStart!);
      const rawEnd = dayDiff(weekStart, t.scheduledEnd!);
      const col = Math.max(0, rawStart);
      const endCol = Math.min(6, rawEnd);
      return {
        task: t,
        col,
        span: endCol - col + 1,
        clipStart: rawStart < 0,
        clipEnd: rawEnd > 6,
        lane: 0,
      };
    })
    .sort((a, b) => (a.task.scheduleOrder - b.task.scheduleOrder)
      || (a.col - b.col)
      || a.task.taskId.localeCompare(b.task.taskId));

  const lanes: Segment[][] = [];
  for (const seg of segs) {
    let i = 0;
    for (;;) {
      const row = lanes[i];
      const collides = row?.some((o) => seg.col < o.col + o.span && o.col < seg.col + seg.span);
      if (!collides) break;
      i++;
    }
    (lanes[i] ??= []).push(seg);
    seg.lane = i;
  }
  return segs;
}

// ── Drag state ─────────────────────────────────────────────────────────────

type DragMode = 'move' | 'resize' | 'schedule';

interface DragState {
  mode: DragMode;
  taskId: string;
  edge?: 'start' | 'end';
  /** Days between the task's start and the day the user grabbed it on. */
  grabOffset: number;
  origStart: string | null;
  origEnd: string | null;
  origLen: number;
  moved: boolean;
}

/** Provisional dates during a drag — kept local so we PATCH once, on drop. */
interface Preview {
  taskId: string;
  start: string;
  end: string;
}

interface PillState {
  x: number;
  y: number;
  /** Either a date range, or a plain message (dropping onto the rail). */
  range: string;
  detail: string;
  delta: string | null;
}

interface Props {
  /** Already filtered to the active task type and scope by TaskBoard. */
  tasks: Task[];
  users: UserSummary[];
  statuses: TaskTypeStatus[];
  /** False paints every bar a neutral surface — the grid then reads purely as
   *  who-is-busy-when, without the status colours competing. */
  colorByStatus: boolean;
  selectedTaskId: string | null;
  highlightTaskId: string | null;
  renamingTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onCardContextMenu: (e: React.MouseEvent, taskId: string) => void;
  onSchedule: (taskId: string, start: string | null, end: string | null, order: number) => void;
  onRenameCommit: (taskId: string, title: string) => void;
  onRenameCancel: () => void;
  onNewTaskOnDay: (date: string) => void;
}

export function TaskCalendarView({
  tasks,
  users,
  statuses,
  colorByStatus,
  selectedTaskId,
  highlightTaskId,
  renamingTaskId,
  onSelectTask,
  onCardContextMenu,
  onSchedule,
  onRenameCommit,
  onRenameCancel,
  onNewTaskOnDay,
}: Readonly<Props>) {
  const today = useMemo(todayIso, []);
  const [view, setView] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pill, setPill] = useState<PillState | null>(null);
  const [dayMenu, setDayMenu] = useState<{ date: string; x: number; y: number } | null>(null);
  // Collapsing the rail matters more than it sounds: every pre-calendar task is
  // unscheduled, so on first use this list is the whole backlog and would push
  // the grid off screen. SSR-safe — the stored value is read post-hydration.
  const [railOpen, setRailOpen] = useState(true);
  const didRestoreRail = useRef(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('lpos:tasks:calendarRail');
      if (stored === 'open' || stored === 'closed') setRailOpen(stored === 'open');
    } catch { /* localStorage may be blocked */ }
    didRestoreRail.current = true;
  }, []);
  useEffect(() => {
    if (!didRestoreRail.current) return;
    try {
      window.localStorage.setItem('lpos:tasks:calendarRail', railOpen ? 'open' : 'closed');
    } catch { /* ignore */ }
  }, [railOpen]);

  const dragRef = useRef<DragState | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  /** Mirrors `preview` so the window listeners can read it without being torn
   *  down and re-registered on every pointer move. */
  const previewRef = useRef<Preview | null>(null);
  /** A drag ends with a click event on the bar. Without this, finishing a drag
   *  would also open the task detail modal. */
  const suppressClickRef = useRef(false);

  const setPreviewBoth = useCallback((next: Preview | null) => {
    previewRef.current = next;
    setPreview(next);
  }, []);

  const statusColor = useCallback(
    (status: string) => statuses.find((s) => s.value === status)?.color ?? 'var(--muted-soft)',
    [statuses],
  );

  /**
   * Finished work isn't planning, so a done task leaves the calendar entirely —
   * grid and rail both. Its stored span is deliberately left untouched in the
   * DB: re-opening the task puts the bar back exactly where it was rather than
   * dumping it in the unscheduled rail.
   */
  const planned = useMemo(
    () => tasks.filter((t) => !isTerminalStatus(t.taskType, t.status)),
    [tasks],
  );

  // Apply the in-flight drag on top of server state, so the bar tracks the
  // cursor without a round trip per pointer move.
  const effective = useMemo(() => planned.map((t) => (
    preview && preview.taskId === t.taskId
      ? { ...t, scheduledStart: preview.start, scheduledEnd: preview.end }
      : t
  )), [planned, preview]);

  const scheduled = useMemo(() => effective.filter((t) => t.scheduledStart && t.scheduledEnd), [effective]);
  const unscheduled = useMemo(
    () => effective.filter((t) => !t.scheduledStart).sort((a, b) => a.scheduleOrder - b.scheduleOrder),
    [effective],
  );

  /**
   * The rail groups by client, which is as close to "by project" as the data
   * gets — Editing tasks lost their project_id in the v8 migration and carry
   * only a client name. Alphabetical, with the "General" sentinel (tasks tied to
   * no client) parked at the end rather than sorted in among real names.
   */
  const unscheduledGroups = useMemo(() => {
    const byClient = new Map<string, Task[]>();
    for (const t of unscheduled) {
      const existing = byClient.get(t.clientName);
      if (existing) existing.push(t);
      else byClient.set(t.clientName, [t]);
    }
    return Array.from(byClient, ([client, items]) => ({ client, items }))
      .sort((a, b) => {
        if (a.client === 'General') return 1;
        if (b.client === 'General') return -1;
        return a.client.localeCompare(b.client);
      });
  }, [unscheduled]);

  const weeks = useMemo(() => {
    const first = new Date(view.year, view.month, 1, 12);
    const gridStart = addDays(first, -((first.getDay() + 6) % 7));
    const lastOfMonth = new Date(view.year, view.month + 1, 0, 12);
    const count = Math.ceil((dayDiff(toIso(gridStart), toIso(lastOfMonth)) + 1) / 7);
    return Array.from({ length: count }, (_, i) => toIso(addDays(gridStart, i * 7)));
  }, [view]);

  useEffect(() => {
    if (!renamingTaskId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTaskId]);

  /** Everything the window-level pointer handlers need, refreshed each render so
   *  the listeners themselves can register once and never churn. */
  const latest = useRef({ scheduled, tasks, onSchedule });
  latest.current = { scheduled, tasks, onSchedule };

  // ── Geometry ─────────────────────────────────────────────────────────────

  /** Which calendar day sits under a viewport point, or null if none does. */
  const hitDay = useCallback((x: number, y: number): { date: string; weekStart: string; lanesTop: number } | null => {
    const rows = gridRef.current?.querySelectorAll<HTMLElement>('[data-week-start]');
    if (!rows) return null;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (y < r.top || y > r.bottom || x < r.left || x > r.right) continue;
      const col = Math.max(0, Math.min(6, Math.floor((x - r.left) / (r.width / 7))));
      const weekStart = row.dataset.weekStart!;
      const lanes = row.querySelector<HTMLElement>('.cal-lanes');
      return {
        date: toIso(addDays(fromIso(weekStart), col)),
        weekStart,
        lanesTop: lanes ? lanes.getBoundingClientRect().top : r.top,
      };
    }
    return null;
  }, []);

  /**
   * Where the pointer landed vertically decides which lane the bar wants. Return
   * an order that sorts it there — the midpoint between its new neighbours, so
   * only the dragged task's row needs writing.
   */
  const orderForDrop = useCallback((weekStart: string, lanesTop: number, pointerY: number, taskId: string): number => {
    const wantLane = Math.max(0, Math.floor((pointerY - lanesTop - DAYNUM_H) / LANE_STEP));
    const others = segmentsForWeek(weekStart, latest.current.scheduled)
      .map((s) => s.task)
      .filter((t) => t.taskId !== taskId);

    if (others.length === 0) return 0;
    const idx = Math.min(wantLane, others.length);
    if (idx === 0) return others[0].scheduleOrder - 1;
    if (idx >= others.length) return others[others.length - 1].scheduleOrder + 1;
    return (others[idx - 1].scheduleOrder + others[idx].scheduleOrder) / 2;
  }, []);

  // ── Drag lifecycle ───────────────────────────────────────────────────────

  function beginDrag(e: React.PointerEvent, task: Task, mode: DragMode, edge?: 'start' | 'end') {
    if (e.button !== 0) return;          // right-click belongs to the context menu
    if (renamingTaskId === task.taskId) return;
    e.preventDefault();
    e.stopPropagation();

    const hit = hitDay(e.clientX, e.clientY);
    const start = task.scheduledStart;
    const end = task.scheduledEnd;
    dragRef.current = {
      mode,
      taskId: task.taskId,
      edge,
      grabOffset: start && end && hit
        ? Math.max(0, Math.min(dayDiff(start, end), dayDiff(start, hit.date)))
        : 0,
      origStart: start,
      origEnd: end,
      origLen: start && end ? dayDiff(start, end) + 1 : 1,
      moved: false,
    };
    if (start && end) {
      setPreviewBoth({ taskId: task.taskId, start, end });
      showPill(e.clientX, e.clientY, start, end, mode);
    }
  }

  function showPill(x: number, y: number, start: string, end: string, mode: DragMode) {
    const days = dayDiff(start, end) + 1;
    const orig = dragRef.current?.origLen ?? days;
    const diff = days - orig;
    setPill({
      x,
      y,
      range: fmtRange(start, end),
      detail: `${days} day${days === 1 ? '' : 's'}`,
      delta: mode === 'resize'
        ? (diff > 0 ? `+${diff}` : diff < 0 ? `−${Math.abs(diff)}` : 'no change')
        : null,
    });
  }

  // Pointer move/up live on window: the gesture must keep working when the
  // cursor leaves the bar, which it does immediately on any real drag.
  useEffect(() => {
    function handleMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      drag.moved = true;

      const hit = hitDay(e.clientX, e.clientY);

      if (!hit) {
        const rail = railRef.current?.getBoundingClientRect();
        const overRail = rail && e.clientY >= rail.top && e.clientY <= rail.bottom
          && e.clientX >= rail.left && e.clientX <= rail.right;
        if (overRail && drag.mode !== 'schedule') {
          setPill({ x: e.clientX, y: e.clientY, range: 'Unplan', detail: 'back to Unscheduled', delta: null });
        }
        return;
      }

      if (drag.mode === 'schedule') {
        setPreviewBoth({ taskId: drag.taskId, start: hit.date, end: hit.date });
        showPill(e.clientX, e.clientY, hit.date, hit.date, 'schedule');
        return;
      }

      const cur = previewRef.current;
      const start = cur?.start ?? drag.origStart;
      const end = cur?.end ?? drag.origEnd;
      if (!start || !end) return;

      let next: Preview;
      if (drag.mode === 'move') {
        const len = dayDiff(start, end);
        const ns = toIso(addDays(fromIso(hit.date), -drag.grabOffset));
        next = { taskId: drag.taskId, start: ns, end: toIso(addDays(fromIso(ns), len)) };
      } else if (drag.edge === 'start') {
        next = { taskId: drag.taskId, start: hit.date <= end ? hit.date : end, end };
      } else {
        next = { taskId: drag.taskId, start, end: hit.date >= start ? hit.date : start };
      }
      setPreviewBoth(next);
      showPill(e.clientX, e.clientY, next.start, next.end, drag.mode);
    }

    function handleUp(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setPill(null);
      // Swallow the click the browser fires after this pointerup, so finishing a
      // drag doesn't also open the task modal. Cleared on the next macrotask
      // rather than by the click handler — a drag that ends over the rail (or
      // outside any bar) produces no click to consume the flag.
      if (drag.moved) {
        suppressClickRef.current = true;
        setTimeout(() => { suppressClickRef.current = false; }, 0);
      }

      if (!drag.moved) { setPreviewBoth(null); return; }

      const hit = hitDay(e.clientX, e.clientY);
      const rail = railRef.current?.getBoundingClientRect();
      const overRail = !hit && rail && e.clientY >= rail.top && e.clientY <= rail.bottom
        && e.clientX >= rail.left && e.clientX <= rail.right;

      if (overRail && drag.mode !== 'schedule') {
        setPreviewBoth(null);
        latest.current.onSchedule(drag.taskId, null, null, 0);
        return;
      }
      if (!hit) { setPreviewBoth(null); return; }   // let go over nothing — snap back

      const cur = previewRef.current;
      const start = drag.mode === 'schedule' ? hit.date : cur?.start;
      const end = drag.mode === 'schedule' ? hit.date : cur?.end;
      setPreviewBoth(null);
      if (!start || !end) return;

      // A resize never changes stacking, so it keeps whatever order it had.
      const order = drag.mode === 'resize'
        ? (latest.current.tasks.find((t) => t.taskId === drag.taskId)?.scheduleOrder ?? 0)
        : orderForDrop(hit.weekStart, hit.lanesTop, e.clientY, drag.taskId);
      latest.current.onSchedule(drag.taskId, start, end, order);
    }

    function handleKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !dragRef.current) return;
      dragRef.current = null;
      setPreviewBoth(null);
      setPill(null);
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      window.removeEventListener('keydown', handleKey);
    };
    // Registered once. Everything mutable is read through `latest` / refs, so
    // these listeners must not be torn down and rebuilt on every pointer move.
  }, [hitDay, orderForDrop, setPreviewBoth]);

  // Close the day menu on any outside press or Escape.
  useEffect(() => {
    if (!dayMenu) return;
    function close() { setDayMenu(null); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setDayMenu(null); }
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [dayMenu]);

  // ── Rendering ────────────────────────────────────────────────────────────

  function renderAvatars(task: Task) {
    const assignees = users.filter((u) => task.assignedTo.includes(u.id)).slice(0, 3);
    return (
      <span className="cal-bar-avs">
        {assignees.map((u) => (
          u.avatarUrl
            ? <img key={u.id} className="task-card-avatar" src={u.avatarUrl} alt={u.name} title={u.name} />
            : (
              <span key={u.id} className="task-card-avatar task-card-avatar--initials" title={u.name}>
                {u.name.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
              </span>
            )
        ))}
        {task.assignedTo.length > 3 && (
          <span className="task-card-avatar task-card-avatar--overflow">+{task.assignedTo.length - 3}</span>
        )}
      </span>
    );
  }

  /** Rail chip. No client label on the chip itself — the group heading above it
   *  already says whose it is. */
  function renderChip(t: Task) {
    return (
      <div
        key={t.taskId}
        data-task-id={t.taskId}
        className={`cal-chip${!colorByStatus ? ' cal-bar--mono' : ''}${highlightTaskId === t.taskId ? ' cal-bar--highlight' : ''}`}
        style={{ '--cal-bar-color': colorByStatus ? statusColor(t.status) : 'var(--line-strong)' } as React.CSSProperties}
        title={`${t.clientName} — ${t.description}`}
        role="button"
        tabIndex={0}
        onPointerDown={(e) => beginDrag(e, t, 'schedule')}
        onClick={() => {
          if (suppressClickRef.current) return;
          if (!dragRef.current) onSelectTask(t.taskId);
        }}
        onContextMenu={(e) => { e.stopPropagation(); onCardContextMenu(e, t.taskId); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectTask(t.taskId); }}
      >
        <span className="cal-chip-title">{t.description}</span>
        {renderAvatars(t)}
      </div>
    );
  }

  function renderBar(seg: Segment) {
    const t = seg.task;
    const isDragging = dragRef.current?.taskId === t.taskId && preview !== null;
    const isRenaming = renamingTaskId === t.taskId;
    const color = colorByStatus ? statusColor(t.status) : 'var(--line-strong)';

    return (
      <div
        key={`${t.taskId}-${seg.col}`}
        data-task-id={t.taskId}
        className={[
          'cal-bar',
          seg.clipStart ? 'cal-bar--clip-start' : '',
          seg.clipEnd ? 'cal-bar--clip-end' : '',
          isDragging ? 'cal-bar--active' : '',
          isDragging && dragRef.current?.mode === 'resize' ? `cal-bar--resizing-${dragRef.current.edge}` : '',
          selectedTaskId === t.taskId ? 'cal-bar--selected' : '',
          highlightTaskId === t.taskId ? 'cal-bar--highlight' : '',
          !colorByStatus ? 'cal-bar--mono' : '',
        ].filter(Boolean).join(' ')}
        style={{
          '--cal-bar-color': color,
          left: `calc(${(seg.col / 7) * 100}% + 4px)`,
          width: `calc(${(seg.span / 7) * 100}% - 8px)`,
          top: `${DAYNUM_H + seg.lane * LANE_STEP}px`,
        } as React.CSSProperties}
        title={`${t.clientName} — ${t.description}\n${fmtRange(t.scheduledStart!, t.scheduledEnd!)}`}
        role="button"
        tabIndex={0}
        onPointerDown={(e) => beginDrag(e, t, 'move')}
        onClick={() => {
          if (suppressClickRef.current) return;
          if (!dragRef.current && !isRenaming) onSelectTask(t.taskId);
        }}
        onContextMenu={(e) => { e.stopPropagation(); onCardContextMenu(e, t.taskId); }}
        onKeyDown={(e) => { if (!isRenaming && (e.key === 'Enter' || e.key === ' ')) onSelectTask(t.taskId); }}
      >
        {!seg.clipStart && (
          <span
            className="cal-handle cal-handle--start"
            onPointerDown={(e) => beginDrag(e, t, 'resize', 'start')}
          />
        )}

        {t.clientName !== 'General' && <span className="cal-bar-client">{t.clientName}</span>}

        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="cal-bar-rename"
            defaultValue={t.description}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const v = e.currentTarget.value.trim();
                if (v) onRenameCommit(t.taskId, v); else onRenameCancel();
              }
              if (e.key === 'Escape') onRenameCancel();
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v && v !== t.description) onRenameCommit(t.taskId, v); else onRenameCancel();
            }}
          />
        ) : (
          <span className="cal-bar-title">{t.description}</span>
        )}

        {renderAvatars(t)}

        {!seg.clipEnd && (
          <span
            className="cal-handle cal-handle--end"
            onPointerDown={(e) => beginDrag(e, t, 'resize', 'end')}
          />
        )}
      </div>
    );
  }

  function shiftMonth(delta: number) {
    setView((v) => {
      const m = v.month + delta;
      if (m < 0) return { year: v.year - 1, month: 11 };
      if (m > 11) return { year: v.year + 1, month: 0 };
      return { year: v.year, month: m };
    });
  }

  return (
    <div className="cal-root">
      <div className="cal-monthbar">
        <button type="button" className="cal-navbtn" onClick={() => shiftMonth(-1)} aria-label="Previous month">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button type="button" className="cal-navbtn" onClick={() => shiftMonth(1)} aria-label="Next month">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <span className="cal-monthlabel">{MONTH_NAMES[view.month]} {view.year}</span>
        <button
          type="button"
          className="cal-todaybtn"
          onClick={() => { const n = new Date(); setView({ year: n.getFullYear(), month: n.getMonth() }); }}
        >
          Today
        </button>

        {colorByStatus && (
          <div className="cal-legend">
            {statuses.map((s) => (
              <span key={s.value} className="cal-legend-item">
                <span className="cal-legend-dot" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="cal-grid">
        <div className="cal-dow-row">
          {DOW_LABELS.map((d, i) => (
            <div key={d} className={`cal-dow${i >= 5 ? ' cal-dow--weekend' : ''}`}>{d}</div>
          ))}
        </div>

        <div ref={gridRef}>
          {weeks.map((weekStart) => {
            const segs = segmentsForWeek(weekStart, scheduled);
            const maxLane = segs.reduce((m, s) => Math.max(m, s.lane), -1);
            const laneCount = Math.max(maxLane + 2, MIN_LANES);

            return (
              <div key={weekStart} className="cal-week" data-week-start={weekStart}>
                <div className="cal-cells">
                  {Array.from({ length: 7 }, (_, i) => {
                    const day = addDays(fromIso(weekStart), i);
                    const dIso = toIso(day);
                    return (
                      <div
                        key={dIso}
                        className={[
                          'cal-cell',
                          i >= 5 ? 'cal-cell--weekend' : '',
                          day.getMonth() !== view.month ? 'cal-cell--outside' : '',
                          dIso === today ? 'cal-cell--today' : '',
                        ].filter(Boolean).join(' ')}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setDayMenu({ date: dIso, x: e.clientX, y: e.clientY });
                        }}
                        onDoubleClick={() => onNewTaskOnDay(dIso)}
                      >
                        <span className="cal-daynum">{day.getDate()}</span>
                      </div>
                    );
                  })}
                </div>

                <div className="cal-lanes" style={{ height: `${DAYNUM_H + laneCount * LANE_STEP + 8}px` }}>
                  {segs.map(renderBar)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div ref={railRef} className={`cal-rail${railOpen ? '' : ' cal-rail--collapsed'}`}>
        <button
          type="button"
          className="cal-rail-head"
          onClick={() => setRailOpen((v) => !v)}
          aria-expanded={railOpen}
          title={railOpen ? 'Collapse the unscheduled list' : 'Expand the unscheduled list'}
        >
          <svg
            className={`cal-rail-caret${railOpen ? ' cal-rail-caret--open' : ''}`}
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="cal-rail-title">Unscheduled</span>
          <span className="cal-rail-count">{unscheduled.length}</span>
          <span className="cal-rail-hint">
            {railOpen
              ? 'Drag onto a day to plan it — drag a bar back here to unplan it.'
              : 'Drag a bar here to unplan it, or expand to plan one.'}
          </span>
        </button>
        <div className="cal-rail-items" hidden={!railOpen}>
          {unscheduled.length === 0 ? (
            <span className="cal-rail-empty">Everything&rsquo;s on the calendar.</span>
          ) : unscheduledGroups.map(({ client, items }) => (
            <div key={client} className="cal-rail-group">
              <span className="cal-rail-group-label" title={client}>{client}</span>
              <div className="cal-rail-group-items">{items.map(renderChip)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Drag readout — hangs under whatever you're holding. */}
      {pill && (
        <div
          className="cal-pill"
          style={{
            left: Math.max(90, Math.min(pill.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 90)),
            top: pill.y + 22,
          }}
        >
          <span className="cal-pill-range">{pill.range}</span>
          <span className="cal-pill-detail">{pill.detail}</span>
          {pill.delta && (
            <span className={`cal-pill-delta${pill.delta === 'no change' ? ' cal-pill-delta--zero' : ''}`}>
              {pill.delta}
            </span>
          )}
        </div>
      )}

      {/* Empty-day menu. Deliberately separate from TaskContextMenu — that one is
          about a task; this one is about a date. Shares its styling. */}
      {dayMenu && (
        <div
          className="task-ctx-menu"
          style={{ left: Math.min(dayMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 232), top: dayMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="task-ctx-day-head">{fmtRange(dayMenu.date, dayMenu.date)}</div>
          <button
            type="button"
            className="task-ctx-item"
            onClick={() => { onNewTaskOnDay(dayMenu.date); setDayMenu(null); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New task on this day
          </button>
        </div>
      )}
    </div>
  );
}
