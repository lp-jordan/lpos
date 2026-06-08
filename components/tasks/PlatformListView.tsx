'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from '@/lib/models/task';
import { getStatusLabel, getStatusColor } from '@/lib/models/task-phase';
import type { UserSummary } from '@/lib/models/user';
import type { TaskCategory } from '@/lib/models/task-category';
import { STARTER_PLATFORM_CATEGORIES } from '@/lib/models/task-categories';

interface Props {
  /** Already filtered to taskType='platform' + the active scope. */
  tasks: Task[];
  users: UserSummary[];
  highlightTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onCardContextMenu: (e: React.MouseEvent, taskId: string) => void;
  onCategoryChange: (taskId: string, newCategory: string) => void;
}

// Tiny local avatar — same look as TaskCard's, just inlined here so the list
// view doesn't have to import a private helper across components.
function Avatar({ user }: { user: UserSummary }) {
  const initials = user.name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return user.avatarUrl ? (
    <img className="task-card-avatar" src={user.avatarUrl} alt={user.name} title={user.name} />
  ) : (
    <span className="task-card-avatar task-card-avatar--initials" title={user.name}>
      {initials}
    </span>
  );
}

interface Group {
  label: string;
  tasks: Task[];
  /** True when the category exists on tasks but isn't in the live admin-managed list
   *  (e.g. the admin deleted "Pass Build" after F4 shipped). Surfaced with a (legacy)
   *  suffix so the user knows to reassign. */
  isOrphan: boolean;
}

// Soft, non-aggressive palette tuned for the dark UI. Each category claims a
// unique swatch via hash-preferred-then-walk-forward: the hash of the label
// picks a preferred index; if that color is already taken by an earlier
// category in iteration order, walk forward in the palette until an unused
// color is found. Uniqueness is guaranteed up to PALETTE.length categories;
// beyond that the algorithm falls back to the hash-preferred color
// (collisions allowed past the cap).
const CATEGORY_PALETTE = [
  '#5e7a9c', // slate blue
  '#6e8e8a', // muted teal
  '#a4787f', // dusty rose
  '#7a9778', // sage green
  '#b59561', // soft amber
  '#857ba8', // lavender
  '#b58783', // muted coral
  '#6c8aa6', // steel blue
  '#8a8a5e', // olive
  '#967696', // dusty plum
  '#6a96a3', // muted cyan
  '#a48472', // tan
];
const ORPHAN_COLOR = '#666';

function hashLabel(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i += 1) {
    h = ((h << 5) - h + label.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function assignCategoryColors(groups: Group[]): Map<string, string> {
  const taken = new Set<string>();
  const map = new Map<string, string>();
  for (const group of groups) {
    if (group.isOrphan) {
      map.set(group.label, ORPHAN_COLOR);
      continue;
    }
    const preferred = hashLabel(group.label) % CATEGORY_PALETTE.length;
    let chosen = CATEGORY_PALETTE[preferred];
    for (let step = 0; step < CATEGORY_PALETTE.length; step += 1) {
      const candidate = CATEGORY_PALETTE[(preferred + step) % CATEGORY_PALETTE.length];
      if (!taken.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    taken.add(chosen);
    map.set(group.label, chosen);
  }
  return map;
}

// Prefix added to droppable IDs so they don't collide with task IDs (UUIDs).
// Note: a single ID is used for BOTH the task→category drop target AND the
// category-reorder sortable item on the same group element (`useSortable`
// internally combines `useDraggable` + `useDroppable`). The drag-end handler
// disambiguates by the `active.id`'s shape: a raw UUID = task drag; a CAT_DROP_
// PREFIX-prefixed ID = category reorder.
const CAT_DROP_PREFIX = 'cat::';

/** Minimal shape we need from a category to render + reorder. The store-side
 *  `TaskCategory` has more fields; we only carry id + label in component state. */
interface CategoryEntry { categoryId: string; label: string; }

/** Synthetic IDs for the starter fallback so the SortableContext has *some*
 *  identity per row when the API hasn't responded yet. Reorder is disabled
 *  in that state (we have no real IDs to POST). */
function starterToEntries(): CategoryEntry[] {
  return STARTER_PLATFORM_CATEGORIES.map((label, i) => ({
    categoryId: `__starter:${i}`,
    label,
  }));
}

export function PlatformListView({
  tasks,
  users,
  highlightTaskId,
  onSelectTask,
  onCardContextMenu,
  onCategoryChange,
}: Readonly<Props>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<CategoryEntry[]>(starterToEntries);
  /** True once the API populated real category IDs; gates the reorder POST. */
  const [hasRealIds, setHasRealIds] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [draggingCategoryLabel, setDraggingCategoryLabel] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);

  // Live category list from the admin-managed store. The admin's sort order
  // dictates the group order in this view. Falls back to the F2 hardcoded list
  // if the API is unreachable (offline / startup race) so the page still renders.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/task-categories');
        if (!res.ok) return;
        const data = await res.json() as { categories?: TaskCategory[] };
        const entries = (data.categories ?? [])
          .filter((c) => c.label)
          .map((c) => ({ categoryId: c.categoryId, label: c.label }));
        if (!cancelled && entries.length > 0) {
          setCategories(entries);
          setHasRealIds(true);
        }
      } catch {
        // keep the fallback
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const groups = useMemo<Group[]>(() => {
    const byLabel = new Map<string, Task[]>();
    const uncategorized: Task[] = [];

    for (const cat of categories) byLabel.set(cat.label, []);
    for (const task of tasks) {
      if (!task.category) {
        uncategorized.push(task);
        continue;
      }
      const bucket = byLabel.get(task.category);
      if (bucket) bucket.push(task);
      else byLabel.set(task.category, [task]);  // orphan category — render at the end
    }

    const ordered: Group[] = [];
    const knownLabels = new Set(categories.map((c) => c.label));
    for (const cat of categories) {
      ordered.push({ label: cat.label, tasks: byLabel.get(cat.label) ?? [], isOrphan: false });
    }
    // Orphan categories (label exists on a task but not in the admin list)
    for (const [label, taskList] of byLabel) {
      if (knownLabels.has(label)) continue;
      ordered.push({ label, tasks: taskList, isOrphan: true });
    }
    if (uncategorized.length > 0) {
      ordered.push({ label: 'Uncategorized', tasks: uncategorized, isOrphan: true });
    }
    return ordered;
  }, [tasks, categories]);

  /** SortableContext needs a stable, ordered ID list for the live (non-orphan)
   *  categories — the orphan/uncategorized groups stay pinned at the end and
   *  are NOT included in the sortable set (you can't drag an orphan into the
   *  ordering store because it has no real categoryId). */
  const sortableIds = useMemo(
    () => categories.map((c) => `${CAT_DROP_PREFIX}${c.label}`),
    [categories],
  );

  // Compute the category→color map once per groups change. This is what makes
  // the "no color used twice" guarantee work: collision resolution needs to
  // see the full iteration order, not just one label at a time.
  const categoryColors = useMemo(() => assignCategoryColors(groups), [groups]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const draggingTask = draggingTaskId
    ? (tasks.find((t) => t.taskId === draggingTaskId) ?? null)
    : null;

  function toggleCollapse(label: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as string;
    if (id.startsWith(CAT_DROP_PREFIX)) {
      setDraggingCategoryLabel(id.slice(CAT_DROP_PREFIX.length));
    } else {
      setDraggingTaskId(id);
    }
  }

  /** Persist a new category order to the server. Optimistic — local state is
   *  already updated before we call this. Rolls back from the server response
   *  on failure (the server's reorder helper is the source of truth). */
  async function persistCategoryOrder(next: CategoryEntry[]) {
    if (!hasRealIds) return;  // starter fallback has no real IDs to POST
    setReorderError(null);
    try {
      const res = await fetch('/api/task-categories/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: next.map((c) => c.categoryId) }),
      });
      const data = await res.json() as { categories?: TaskCategory[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to reorder.');
      if (data.categories) {
        setCategories(
          data.categories
            .filter((c) => c.label)
            .map((c) => ({ categoryId: c.categoryId, label: c.label })),
        );
      }
    } catch (err) {
      setReorderError((err as Error).message);
      // Roll back to whatever the server says is authoritative.
      try {
        const res = await fetch('/api/task-categories');
        if (res.ok) {
          const data = await res.json() as { categories?: TaskCategory[] };
          const entries = (data.categories ?? [])
            .filter((c) => c.label)
            .map((c) => ({ categoryId: c.categoryId, label: c.label }));
          if (entries.length > 0) setCategories(entries);
        }
      } catch { /* keep optimistic state if rollback fetch also fails */ }
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingTaskId(null);
    setDraggingCategoryLabel(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = active.id as string;
    const overId   = over.id as string;

    // ── Category reorder ────────────────────────────────────────────────────
    if (activeId.startsWith(CAT_DROP_PREFIX)) {
      if (!overId.startsWith(CAT_DROP_PREFIX) || activeId === overId) return;
      const activeLabel = activeId.slice(CAT_DROP_PREFIX.length);
      const overLabel   = overId.slice(CAT_DROP_PREFIX.length);
      const oldIdx = categories.findIndex((c) => c.label === activeLabel);
      const newIdx = categories.findIndex((c) => c.label === overLabel);
      if (oldIdx === -1 || newIdx === -1) return;
      const next = arrayMove(categories, oldIdx, newIdx);
      setCategories(next);            // optimistic
      void persistCategoryOrder(next);
      return;
    }

    // ── Task → category drop (existing) ─────────────────────────────────────
    if (!overId.startsWith(CAT_DROP_PREFIX)) return;
    const newCategory = overId.slice(CAT_DROP_PREFIX.length);
    const task = tasks.find((t) => t.taskId === activeId);
    if (!task || task.category === newCategory) return;
    onCategoryChange(task.taskId, newCategory);
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="platform-list">
        {reorderError && (
          <p className="platform-list-reorder-error" role="alert">{reorderError}</p>
        )}

        <div className="platform-list-cols" role="row">
          <div className="platform-list-col platform-list-col--handle" aria-hidden="true" />
          <div className="platform-list-col platform-list-col--desc">Description</div>
          <div className="platform-list-col">Client</div>
          <div className="platform-list-col">Person</div>
          <div className="platform-list-col">Status</div>
          <div className="platform-list-col">Priority</div>
        </div>

        {groups.length === 0 && (
          <p className="platform-list-empty">No platform tasks yet.</p>
        )}

        {/* SortableContext only covers the live (non-orphan) categories — they
         *  are the rows the user can reorder. Orphan + Uncategorized groups
         *  render after the context, pinned in place. */}
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {groups.filter((g) => !g.isOrphan).map((group) => {
            const isCollapsed = collapsed.has(group.label);
            const color = categoryColors.get(group.label) ?? ORPHAN_COLOR;
            const colorFaint = `${color}22`;
            return (
              <SortableCategoryGroup
                key={group.label}
                group={group}
                color={color}
                colorFaint={colorFaint}
                isCollapsed={isCollapsed}
                onToggleCollapse={() => toggleCollapse(group.label)}
                users={users}
                highlightTaskId={highlightTaskId}
                onSelectTask={onSelectTask}
                onCardContextMenu={onCardContextMenu}
                reorderable={hasRealIds}
              />
            );
          })}
        </SortableContext>

        {groups.filter((g) => g.isOrphan).map((group) => {
          const isCollapsed = collapsed.has(group.label);
          const color = categoryColors.get(group.label) ?? ORPHAN_COLOR;
          const colorFaint = `${color}22`;
          return (
            <SortableCategoryGroup
              key={group.label}
              group={group}
              color={color}
              colorFaint={colorFaint}
              isCollapsed={isCollapsed}
              onToggleCollapse={() => toggleCollapse(group.label)}
              users={users}
              highlightTaskId={highlightTaskId}
              onSelectTask={onSelectTask}
              onCardContextMenu={onCardContextMenu}
              reorderable={false}
            />
          );
        })}
      </div>

      <DragOverlay>
        {draggingTask && (
          <div className="platform-list-drag-overlay">
            {draggingTask.description}
          </div>
        )}
        {draggingCategoryLabel && (
          <div className="platform-list-drag-overlay platform-list-drag-overlay--category">
            {draggingCategoryLabel}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function SortableCategoryGroup({
  group,
  color,
  colorFaint,
  isCollapsed,
  onToggleCollapse,
  users,
  highlightTaskId,
  onSelectTask,
  onCardContextMenu,
  reorderable,
}: Readonly<{
  group: Group;
  color: string;
  colorFaint: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  users: UserSummary[];
  highlightTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onCardContextMenu: (e: React.MouseEvent, taskId: string) => void;
  /** When false (orphan/uncategorized, or starter-fallback state without real
   *  IDs), the left-side drag handle is hidden — but the group remains a
   *  droppable target for task→category drops. */
  reorderable: boolean;
}>) {
  // `useSortable` provides both the draggable activator (for the handle) and
  // the droppable target (for both task drops AND category-reorder hover). The
  // disambiguation between "task landed here" vs "category landed here" happens
  // in handleDragEnd via active.id's prefix.
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: `${CAT_DROP_PREFIX}${group.label}`,
    disabled: !reorderable,  // orphans/starter-fallback aren't reorderable, but they still receive drops via isOver
  });

  const style: React.CSSProperties = {
    '--cat-color': color,
    '--cat-color-faint': colorFaint,
    transform: CSS.Transform.toString(transform),
    transition,
  } as React.CSSProperties;

  return (
    <div
      ref={setNodeRef}
      className={[
        'platform-list-group',
        isOver        ? 'platform-list-group--drag-over' : '',
        isDragging    ? 'platform-list-group--reordering' : '',
      ].filter(Boolean).join(' ')}
      style={style}
    >
      <div className="platform-list-group-header-wrap">
        {reorderable && (
          <div
            className="platform-list-group-drag-handle"
            {...attributes}
            {...listeners}
            // Stop click bubbling so grabbing the handle doesn't toggle the
            // collapse state of the underlying header button.
            onClick={(e) => e.stopPropagation()}
            title="Drag to reorder category"
            aria-label={`Drag to reorder ${group.label}`}
          >
            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
              <circle cx="2" cy="2"  r="1.5"/>
              <circle cx="8" cy="2"  r="1.5"/>
              <circle cx="2" cy="7"  r="1.5"/>
              <circle cx="8" cy="7"  r="1.5"/>
              <circle cx="2" cy="12" r="1.5"/>
              <circle cx="8" cy="12" r="1.5"/>
            </svg>
          </div>
        )}
      <button
        type="button"
        className="platform-list-group-header"
        onClick={onToggleCollapse}
        aria-expanded={!isCollapsed}
      >
        <span className="platform-list-group-chevron">{isCollapsed ? '▸' : '▾'}</span>
        <span className="platform-list-group-name">
          {group.label}
          {group.isOrphan && <span className="platform-list-group-orphan"> (legacy)</span>}
        </span>
        <span className="platform-list-group-count">{group.tasks.length}</span>
      </button>
      </div>

      {!isCollapsed && group.tasks.length === 0 && (
        <div className="platform-list-group-empty">No tasks in this category.</div>
      )}

      {!isCollapsed && group.tasks.map((task) => (
        <DraggableListRow
          key={task.taskId}
          task={task}
          users={users}
          highlight={highlightTaskId === task.taskId}
          onSelectTask={onSelectTask}
          onCardContextMenu={onCardContextMenu}
        />
      ))}
    </div>
  );
}

function DraggableListRow({
  task,
  users,
  highlight,
  onSelectTask,
  onCardContextMenu,
}: Readonly<{
  task: Task;
  users: UserSummary[];
  highlight: boolean;
  onSelectTask: (taskId: string) => void;
  onCardContextMenu: (e: React.MouseEvent, taskId: string) => void;
}>) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.taskId });

  const statusLabel = getStatusLabel(task.taskType, task.status);
  const statusColor = getStatusColor(task.taskType, task.status);
  const assignees = users.filter((u) => task.assignedTo.includes(u.id));
  const visibleAssignees = assignees.slice(0, 3);
  const overflow = assignees.length - visibleAssignees.length;

  return (
    <div
      ref={setNodeRef}
      data-task-id={task.taskId}
      className={`platform-list-row${highlight ? ' platform-list-row--highlight' : ''}${isDragging ? ' platform-list-row--dragging' : ''}`}
      role="row"
      onClick={() => onSelectTask(task.taskId)}
      onContextMenu={(e) => onCardContextMenu(e, task.taskId)}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelectTask(task.taskId); }}
    >
      <div
        className="platform-list-drag-handle"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        title="Drag to move to a different category"
      >
        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
          <circle cx="2" cy="2"  r="1.5"/>
          <circle cx="8" cy="2"  r="1.5"/>
          <circle cx="2" cy="7"  r="1.5"/>
          <circle cx="8" cy="7"  r="1.5"/>
          <circle cx="2" cy="12" r="1.5"/>
          <circle cx="8" cy="12" r="1.5"/>
        </svg>
      </div>

      <div className="platform-list-cell platform-list-cell--desc" title={task.description}>
        {task.description}
      </div>
      <div className="platform-list-cell">
        {task.clientName === 'General' ? <span className="platform-list-cell--muted">—</span> : task.clientName}
      </div>
      <div className="platform-list-cell platform-list-cell--avatars">
        {visibleAssignees.length === 0 ? (
          <span className="platform-list-cell--muted">Unassigned</span>
        ) : (
          <>
            {visibleAssignees.map((u) => <Avatar key={u.id} user={u} />)}
            {overflow > 0 && (
              <span className="task-card-avatar task-card-avatar--overflow">+{overflow}</span>
            )}
          </>
        )}
      </div>
      <div className="platform-list-cell">
        <span
          className="platform-list-status"
          style={{ background: statusColor, color: pickContrastingText(statusColor) }}
        >
          {statusLabel}
        </span>
      </div>
      <div className="platform-list-cell">
        <span className={`task-priority-badge task-priority-badge--${task.priority}`}>
          {task.priority}
        </span>
      </div>
    </div>
  );
}

/** Picks black or white text for readability against a given hex background.
 *  Lifted from the WCAG-ish relative-luminance formula; the threshold (0.6)
 *  is empirically tuned for the existing palette of status colors. */
function pickContrastingText(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return '#fff';
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.6 ? '#1a1207' : '#fff';
}
