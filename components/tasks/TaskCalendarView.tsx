'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@/lib/models/task';
import type { TaskTypeStatus } from '@/lib/models/task-phase';
import { isTerminalStatus } from '@/lib/models/task-phase';
import { REVIEW_STATUS } from '@/lib/models/task-review-checkin';
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
/** Day cells aim to be square. Clamped so a very wide window doesn't produce
 *  absurdly tall rows, and a narrow one still leaves room to read a bar. */
const CELL_MIN_H = 104;
const CELL_MAX_H = 176;
/** Below this width the month collapses to the compact, dot-per-day layout. */
const COMPACT_MAX_W = 640;
const COMPACT_CELL_MIN_H = 40;
const COMPACT_CELL_MAX_H = 64;

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
/**
 * The default rule for whether a task belongs on the calendar. The calendar
 * shows work that is in an editor's hands, so two statuses drop out of it:
 *
 *  - Done: finished work isn't planning.
 *  - In Review: the job has left the editor and is waiting on someone else, so
 *    there is no day on which they are working on it.
 *
 * "Usually" is the operative word — `Task.calendarVisible` overrides this in
 * either direction, for the job that is genuinely parked or the one that is
 * genuinely still being worked while nominally in review.
 */
export function calendarDefaultVisible(task: Task): boolean {
  return !isTerminalStatus(task.taskType, task.status) && task.status !== REVIEW_STATUS;
}

// ── Working calendar ───────────────────────────────────────────────────────
// Which days are worked is DATA, not a rule, and there is no weekly pattern:
// EVERY day is workable, including weekends, until someone explicitly skips it.
// A skip splits a span — Mon, [skip Tue], Wed — and the weekend is just the
// common case of that, not a special case in the code.

/**
 * JS getDay() indices that are off before any override. Deliberately EMPTY:
 * weekends are ordinary workable days, and a Saturday only becomes off when
 * someone right-clicks Skip on it. Kept as the seam where a configurable
 * working week would plug in (admin Settings) without touching anything below.
 */
const DEFAULT_OFF_DOW = new Set<number>();
/** Bound on outward day scans, so a pathological all-off set can't spin. */
const MAX_DAY_SCAN = 400;

/** date -> true (worked) | false (off). Absent means "use the default pattern". */
export type DayOverrides = Record<string, boolean>;

interface WorkCalendar {
  isOff(iso: string): boolean;
  /** Nearest worked day. Ties resolve backwards, so Saturday falls to Friday
   *  while Sunday (whose Saturday neighbour is also off) reaches Monday. */
  snap(iso: string): string;
  /** Worked days from start to end, inclusive. 0 when end precedes start. */
  span(start: string, end: string): number;
  /** Shift by n worked days. n = 0 returns the day unchanged. */
  add(iso: string, n: number): string;
}

function makeWorkCalendar(overrides: DayOverrides): WorkCalendar {
  function isOff(iso: string): boolean {
    const o = overrides[iso];
    if (o !== undefined) return !o;
    return DEFAULT_OFF_DOW.has(fromIso(iso).getDay());
  }

  function snap(iso: string): string {
    if (!isOff(iso)) return iso;
    for (let d = 1; d <= MAX_DAY_SCAN; d++) {
      const back = toIso(addDays(fromIso(iso), -d));
      if (!isOff(back)) return back;
      const fwd = toIso(addDays(fromIso(iso), d));
      if (!isOff(fwd)) return fwd;
    }
    return iso;
  }

  function span(start: string, end: string): number {
    const total = dayDiff(start, end);
    if (total < 0) return 0;
    let n = 0;
    for (let i = 0; i <= total; i++) {
      if (!isOff(toIso(addDays(fromIso(start), i)))) n++;
    }
    return n;
  }

  function add(iso: string, n: number): string {
    let cur = fromIso(iso);
    let left = n;
    let guard = 0;
    while (left > 0 && guard++ < MAX_DAY_SCAN) { cur = addDays(cur, 1); if (!isOff(toIso(cur))) left--; }
    while (left < 0 && guard++ < MAX_DAY_SCAN) { cur = addDays(cur, -1); if (!isOff(toIso(cur))) left++; }
    return toIso(cur);
  }

  return { isOff, snap, span, add };
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

interface WeekEntry {
  task: Task;
  runs: Array<{ col: number; span: number; clipStart: boolean; clipEnd: boolean }>;
  minCol: number;
  maxCol: number;
  lane: number;
}

/**
 * Break each task's coverage of one week into contiguous runs of WORKED days,
 * then stack. A skipped day splits a bar in two, which is how "we're not on
 * this that day" should read; the weekend break is just the common case of it.
 *
 * Runs of the same task always share a lane — collision is tested against the
 * task's whole extent in the week, so nothing threads through another bar's gap.
 */
function segmentsForWeek(weekStart: string, tasks: Task[], cal: WorkCalendar): Segment[] {
  const days = Array.from({ length: 7 }, (_, i) => toIso(addDays(fromIso(weekStart), i)));
  const weekEnd = days[6];

  const entries: WeekEntry[] = [];

  for (const t of tasks) {
    if (!t.scheduledStart || !t.scheduledEnd) continue;
    if (dayDiff(weekStart, t.scheduledEnd) < 0 || dayDiff(t.scheduledStart, weekEnd) < 0) continue;

    const runs: WeekEntry['runs'] = [];
    let runStart = -1;
    for (let i = 0; i <= 7; i++) {
      const d = days[i];
      const worked = i < 7
        && dayDiff(t.scheduledStart, d) >= 0
        && dayDiff(d, t.scheduledEnd) >= 0
        && !cal.isOff(d);

      if (worked && runStart === -1) runStart = i;
      if (!worked && runStart !== -1) {
        const firstIso = days[runStart];
        const lastIso = days[i - 1];
        runs.push({
          col: runStart,
          span: i - runStart,
          // Square the end only where worked days genuinely continue past it —
          // so a span whose tail falls on skipped days still shows its handle.
          clipStart: cal.span(t.scheduledStart, toIso(addDays(fromIso(firstIso), -1))) > 0,
          clipEnd: cal.span(toIso(addDays(fromIso(lastIso), 1)), t.scheduledEnd) > 0,
        });
        runStart = -1;
      }
    }
    if (runs.length === 0) continue;

    const last = runs[runs.length - 1];
    entries.push({
      task: t,
      runs,
      minCol: runs[0].col,
      maxCol: last.col + last.span - 1,
      lane: 0,
    });
  }

  entries.sort((a, b) => (a.task.scheduleOrder - b.task.scheduleOrder)
    || (a.minCol - b.minCol)
    || a.task.taskId.localeCompare(b.task.taskId));

  const lanes: Array<Array<{ min: number; max: number }>> = [];
  for (const e of entries) {
    let i = 0;
    for (;;) {
      const row = lanes[i];
      const collides = row?.some((o) => e.minCol <= o.max && o.min <= e.maxCol);
      if (!collides) break;
      i++;
    }
    (lanes[i] ??= []).push({ min: e.minCol, max: e.maxCol });
    e.lane = i;
  }

  return entries.flatMap((e) => e.runs.map((r) => ({ ...r, task: e.task, lane: e.lane })));
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
  /** Toggles `colorByStatus`. The control lives in the calendar's own month bar
   *  next to the legend it affects, not in the global task toolbar — it is a
   *  calendar-only setting, and having it there made the toolbar reflow every
   *  time you switched between board and calendar. */
  onToggleColor: () => void;
  selectedTaskId: string | null;
  highlightTaskId: string | null;
  renamingTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onCardContextMenu: (e: React.MouseEvent, taskId: string) => void;
  onSchedule: (taskId: string, start: string | null, end: string | null, order: number) => void;
  onRenameCommit: (taskId: string, title: string) => void;
  onRenameCancel: () => void;
  onNewTaskOnDay: (date: string) => void;
  /** Per-date exceptions to the default working week. */
  dayOverrides: DayOverrides;
  /** `working = null` clears the override, returning the day to the default. */
  onSetDayWorking: (date: string, working: boolean | null) => void;
}

export function TaskCalendarView({
  tasks,
  users,
  statuses,
  colorByStatus,
  onToggleColor,
  selectedTaskId,
  highlightTaskId,
  renamingTaskId,
  onSelectTask,
  onCardContextMenu,
  onSchedule,
  onRenameCommit,
  onRenameCancel,
  onNewTaskOnDay,
  dayOverrides,
  onSetDayWorking,
}: Readonly<Props>) {
  const today = useMemo(todayIso, []);
  const cal = useMemo(() => makeWorkCalendar(dayOverrides), [dayOverrides]);
  /** Whether this date is off *before* any override. With DEFAULT_OFF_DOW empty
   *  this is always false — every day starts workable — but it keeps the
   *  clear-vs-store decision below correct if a default pattern is ever added. */
  const isDefaultOff = useCallback(
    (iso: string) => DEFAULT_OFF_DOW.has(fromIso(iso).getDay()), []);
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
   * What the calendar shows: the task's own override if it has one, otherwise
   * the default rule (see calendarDefaultVisible). Stored spans are left
   * untouched either way, so a task that comes back — a review bounce to Making
   * Changes, or an un-hide — restores its bar where it was rather than landing
   * in the unscheduled rail.
   */
  const planned = useMemo(
    () => tasks.filter((t) => t.calendarVisible ?? calendarDefaultVisible(t)),
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

  /**
   * Track one day-cell's width so rows can be driven to roughly square. Without
   * this, a week row is only as tall as the bars inside it, so cells render as
   * wide flat rectangles and anything below the grid (the unscheduled rail)
   * appears to be squashing the calendar. Measured rather than done with CSS
   * `aspect-ratio`, because a row also has to be free to grow past square when
   * it holds more stacked bars than a square would fit.
   */
  const [cellWidth, setCellWidth] = useState(0);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      setCellWidth((entry?.contentRect.width ?? 0) / 7);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Phone layout, iOS-Calendar style: the month collapses to small squares that
   * carry dots instead of bars, and the selected day's work is listed below the
   * grid. A span bar is simply unreadable in a ~50px-wide cell.
   */
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(`(max-width: ${COMPACT_MAX_W}px)`);
    const apply = () => setCompact(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  /** Square, clamped. 0 before the first measurement — rows then fall back to
   *  their content height, which is what they did before this existed. */
  const squareRowHeight = cellWidth
    ? Math.min(
      Math.max(cellWidth, compact ? COMPACT_CELL_MIN_H : CELL_MIN_H),
      compact ? COMPACT_CELL_MAX_H : CELL_MAX_H,
    )
    : 0;

  /** Which day the compact list is showing. Follows the month when you page
   *  away from the one holding the current selection. */
  const [selectedDay, setSelectedDay] = useState(today);
  useEffect(() => {
    const d = fromIso(selectedDay);
    if (d.getFullYear() === view.year && d.getMonth() === view.month) return;
    const now = fromIso(today);
    setSelectedDay(now.getFullYear() === view.year && now.getMonth() === view.month
      ? today
      : toIso(new Date(view.year, view.month, 1, 12)));
  }, [view, selectedDay, today]);

  /** Scheduled tasks whose span covers a given day, in stacking order. */
  const tasksOnDay = useCallback((dateIso: string) => cal.isOff(dateIso) ? [] : scheduled
    .filter((t) => dayDiff(t.scheduledStart!, dateIso) >= 0 && dayDiff(dateIso, t.scheduledEnd!) >= 0)
    .sort((a, b) => a.scheduleOrder - b.scheduleOrder), [scheduled, cal]);

  /** Everything the window-level pointer handlers need, refreshed each render so
   *  the listeners themselves can register once and never churn. */
  const latest = useRef({ scheduled, tasks, onSchedule, cal });
  latest.current = { scheduled, tasks, onSchedule, cal };

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
    const others = segmentsForWeek(weekStart, latest.current.scheduled, latest.current.cal)
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
      // Counted in WORKING days: grabbing a Fri-start bar on the following
      // Monday is an offset of 1, not 3.
      grabOffset: start && end && hit
        ? Math.max(0, Math.min(cal.span(start, end) - 1, cal.span(start, cal.snap(hit.date)) - 1))
        : 0,
      origStart: start,
      origEnd: end,
      origLen: start && end ? cal.span(start, end) : 1,
      moved: false,
    };
    if (start && end) {
      setPreviewBoth({ taskId: task.taskId, start, end });
      showPill(e.clientX, e.clientY, start, end, mode);
    }
  }

  function showPill(x: number, y: number, start: string, end: string, mode: DragMode) {
    const days = latest.current.cal.span(start, end);
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

      const landing = latest.current.cal.snap(hit.date);

      if (drag.mode === 'schedule') {
        setPreviewBoth({ taskId: drag.taskId, start: landing, end: landing });
        showPill(e.clientX, e.clientY, landing, landing, 'schedule');
        return;
      }

      const cur = previewRef.current;
      const start = cur?.start ?? drag.origStart;
      const end = cur?.end ?? drag.origEnd;
      if (!start || !end) return;

      let next: Preview;
      if (drag.mode === 'move') {
        // Preserve the working-day length, so a 3-day job dropped on a Thursday
        // becomes Thu, Fri, Mon rather than Thu, Fri, Sat.
        const len = latest.current.cal.span(start, end);
        const ns = latest.current.cal.add(landing, -drag.grabOffset);
        next = { taskId: drag.taskId, start: ns, end: latest.current.cal.add(ns, len - 1) };
      } else if (drag.edge === 'start') {
        next = { taskId: drag.taskId, start: landing <= end ? landing : end, end };
      } else {
        next = { taskId: drag.taskId, start, end: landing >= start ? landing : start };
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
      const dropDay = latest.current.cal.snap(hit.date);
      const start = drag.mode === 'schedule' ? dropDay : cur?.start;
      const end = drag.mode === 'schedule' ? dropDay : cur?.end;
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

        <div className="cal-legend">
          {colorByStatus && statuses.map((s) => (
            <span key={s.value} className="cal-legend-item">
              <span className="cal-legend-dot" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          <button
            type="button"
            className={`cal-colorbtn${colorByStatus ? ' cal-colorbtn--on' : ''}`}
            onClick={onToggleColor}
            aria-pressed={colorByStatus}
            title={colorByStatus ? 'Status colours on — click to mute' : 'Status colours off — click to restore'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="13.5" cy="6.5" r="2.5" />
              <circle cx="17.5" cy="13" r="2.5" />
              <circle cx="8.5" cy="7.5" r="2.5" />
              <circle cx="6.5" cy="13.5" r="2.5" />
              <path d="M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2 2 2 0 0 1 2-2h1a5 5 0 0 0 5-5c0-6-4.5-11-10-11z" />
            </svg>
            {colorByStatus ? 'Colour' : 'Muted'}
          </button>
        </div>
      </div>

      <div className="cal-grid">
        <div className="cal-dow-row">
          {DOW_LABELS.map((d, i) => (
            <div key={d} className={`cal-dow${i >= 5 ? ' cal-dow--weekend' : ''}`}>{d}</div>
          ))}
        </div>

        <div ref={gridRef}>
          {weeks.map((weekStart) => {
            const segs = segmentsForWeek(weekStart, scheduled, cal);
            const maxLane = segs.reduce((m, s) => Math.max(m, s.lane), -1);
            const laneCount = Math.max(maxLane + 2, MIN_LANES);
            // The row is square, or tall enough for its stacked bars — whichever
            // is bigger. The cells carry it (they're in flow); the lane box just
            // overlays them. Compact draws no bars, so it takes the square
            // straight: reserving lane space there would undo the small squares.
            const rowHeight = compact
              ? squareRowHeight
              : Math.max(DAYNUM_H + laneCount * LANE_STEP + 8, squareRowHeight);

            return (
              <div key={weekStart} className="cal-week" data-week-start={weekStart}>
                <div className="cal-cells" style={{ minHeight: `${rowHeight}px` }}>
                  {Array.from({ length: 7 }, (_, i) => {
                    const day = addDays(fromIso(weekStart), i);
                    const dIso = toIso(day);
                    // Compact: a bar is unreadable in a ~50px cell, so the day
                    // carries dots and the list below the grid does the reading.
                    const dots = compact && !cal.isOff(dIso) ? tasksOnDay(dIso) : [];
                    return (
                      <div
                        key={dIso}
                        className={[
                          'cal-cell',
                          // Weekend shading is purely cosmetic — it reads as a
                          // week boundary, not as an unavailable day.
                          i >= 5 ? 'cal-cell--weekend' : '',
                          cal.isOff(dIso) ? 'cal-cell--off' : '',
                          day.getMonth() !== view.month ? 'cal-cell--outside' : '',
                          dIso === today ? 'cal-cell--today' : '',
                          compact && dIso === selectedDay ? 'cal-cell--picked' : '',
                        ].filter(Boolean).join(' ')}
                        onClick={compact ? () => setSelectedDay(dIso) : undefined}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          // Snapped, so the menu offers (and names) a day that
                          // can actually hold work.
                          setDayMenu({ date: dIso, x: e.clientX, y: e.clientY });
                        }}
                        onDoubleClick={() => onNewTaskOnDay(cal.snap(dIso))}
                      >
                        <span className="cal-daynum">{day.getDate()}</span>
                        {compact && dots.length > 0 && (
                          <span className="cal-dots">
                            {dots.slice(0, 3).map((t) => (
                              <span
                                key={t.taskId}
                                className="cal-dot"
                                style={{ background: colorByStatus ? statusColor(t.status) : 'var(--muted-soft)' }}
                              />
                            ))}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {!compact && (
                  <div className="cal-lanes">
                    {segs.map(renderBar)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Compact day list — what the dots in the grid above stand for. */}
      {compact && (() => {
        const dayTasks = tasksOnDay(selectedDay);
        return (
          <div className="cal-daylist">
            <div className="cal-daylist-head">
              <span className="cal-daylist-date">{fmtRange(selectedDay, selectedDay)}</span>
              <button
                type="button"
                className="cal-daylist-add"
                onClick={() => onNewTaskOnDay(selectedDay)}
              >
                + New task
              </button>
            </div>
            {dayTasks.length === 0 ? (
              <p className="cal-daylist-empty">Nothing planned for this day.</p>
            ) : dayTasks.map((t) => (
              <button
                key={t.taskId}
                type="button"
                data-task-id={t.taskId}
                className="cal-daylist-row"
                style={{ '--cal-bar-color': colorByStatus ? statusColor(t.status) : 'var(--line-strong)' } as React.CSSProperties}
                onClick={() => onSelectTask(t.taskId)}
                onContextMenu={(e) => { e.stopPropagation(); onCardContextMenu(e, t.taskId); }}
              >
                <span className="cal-daylist-main">
                  {t.clientName !== 'General' && <span className="cal-daylist-client">{t.clientName}</span>}
                  <span className="cal-daylist-title">{t.description}</span>
                  {t.scheduledStart !== t.scheduledEnd && (
                    <span className="cal-daylist-span">{fmtRange(t.scheduledStart!, t.scheduledEnd!)}</span>
                  )}
                </span>
                {renderAvatars(t)}
              </button>
            ))}
          </div>
        );
      })()}

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
          <div className="task-ctx-day-head">
            {fmtRange(dayMenu.date, dayMenu.date)}
            {cal.isOff(dayMenu.date) && <span className="task-ctx-day-off"> · off</span>}
          </div>

          {!cal.isOff(dayMenu.date) && (
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
          )}

          {/* Skip / work. Toggling back to the default pattern clears the
              override rather than storing a row that says nothing. */}
          <button
            type="button"
            className="task-ctx-item"
            onClick={() => {
              const wantWorking = cal.isOff(dayMenu.date);
              const matchesDefault = wantWorking === !isDefaultOff(dayMenu.date);
              onSetDayWorking(dayMenu.date, matchesDefault ? null : wantWorking);
              setDayMenu(null);
            }}
          >
            {cal.isOff(dayMenu.date) ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                Work this day
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" /><line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
                </svg>
                Skip this day
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
