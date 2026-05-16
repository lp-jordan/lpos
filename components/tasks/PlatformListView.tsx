'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@/lib/models/task';
import { getStatusLabel, getStatusColor } from '@/lib/models/task-phase';
import type { UserSummary } from '@/lib/models/user';
import type { TaskCategory } from '@/lib/models/task-category';
import { STARTER_PLATFORM_CATEGORIES } from '@/lib/models/task-categories';

interface Props {
  /** Already filtered to taskType='platform' + the active scope. */
  tasks: Task[];
  users: UserSummary[];
  onSelectTask: (taskId: string) => void;
  onCardContextMenu: (e: React.MouseEvent, taskId: string) => void;
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

export function PlatformListView({ tasks, users, onSelectTask, onCardContextMenu }: Readonly<Props>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<string[]>(STARTER_PLATFORM_CATEGORIES);

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
        const labels = (data.categories ?? []).map((c) => c.label).filter(Boolean);
        if (!cancelled && labels.length > 0) setCategories(labels);
      } catch {
        // keep the fallback
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const groups = useMemo<Group[]>(() => {
    const byLabel = new Map<string, Task[]>();
    const uncategorized: Task[] = [];

    for (const cat of categories) byLabel.set(cat, []);
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
    for (const cat of categories) {
      ordered.push({ label: cat, tasks: byLabel.get(cat) ?? [], isOrphan: false });
    }
    // Orphan categories (label exists on a task but not in the admin list)
    for (const [label, taskList] of byLabel) {
      if (categories.includes(label)) continue;
      ordered.push({ label, tasks: taskList, isOrphan: true });
    }
    if (uncategorized.length > 0) {
      ordered.push({ label: 'Uncategorized', tasks: uncategorized, isOrphan: true });
    }
    return ordered;
  }, [tasks, categories]);

  // Compute the category→color map once per groups change. This is what makes
  // the "no color used twice" guarantee work: collision resolution needs to
  // see the full iteration order, not just one label at a time.
  const categoryColors = useMemo(() => assignCategoryColors(groups), [groups]);

  function toggleCollapse(label: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <div className="platform-list">
      <div className="platform-list-cols" role="row">
        <div className="platform-list-col platform-list-col--desc">Description</div>
        <div className="platform-list-col">Client</div>
        <div className="platform-list-col">Person</div>
        <div className="platform-list-col">Status</div>
        <div className="platform-list-col">Priority</div>
      </div>

      {groups.length === 0 && (
        <p className="platform-list-empty">No platform tasks yet.</p>
      )}

      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.label);
        const color = categoryColors.get(group.label) ?? ORPHAN_COLOR;
        // Append two hex chars to the 6-char hex to control alpha at the CSS
        // layer without needing color-mix() — works in every browser.
        const colorFaint = `${color}22`; // ~13% opacity tint
        return (
          <div
            key={group.label}
            className="platform-list-group"
            style={{ '--cat-color': color, '--cat-color-faint': colorFaint } as React.CSSProperties}
          >
            <button
              type="button"
              className="platform-list-group-header"
              onClick={() => toggleCollapse(group.label)}
              aria-expanded={!isCollapsed}
            >
              <span className="platform-list-group-chevron">{isCollapsed ? '▸' : '▾'}</span>
              <span className="platform-list-group-name">
                {group.label}
                {group.isOrphan && <span className="platform-list-group-orphan"> (legacy)</span>}
              </span>
              <span className="platform-list-group-count">{group.tasks.length}</span>
            </button>

            {!isCollapsed && group.tasks.length === 0 && (
              <div className="platform-list-group-empty">No tasks in this category.</div>
            )}

            {!isCollapsed && group.tasks.map((task) => (
              <PlatformListRow
                key={task.taskId}
                task={task}
                users={users}
                onSelectTask={onSelectTask}
                onCardContextMenu={onCardContextMenu}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function PlatformListRow({
  task, users, onSelectTask, onCardContextMenu,
}: Readonly<{
  task: Task;
  users: UserSummary[];
  onSelectTask: (taskId: string) => void;
  onCardContextMenu: (e: React.MouseEvent, taskId: string) => void;
}>) {
  const statusLabel = getStatusLabel(task.taskType, task.status);
  const statusColor = getStatusColor(task.taskType, task.status);
  const assignees = users.filter((u) => task.assignedTo.includes(u.id));
  const visibleAssignees = assignees.slice(0, 3);
  const overflow = assignees.length - visibleAssignees.length;

  return (
    <div
      className="platform-list-row"
      role="row"
      onClick={() => onSelectTask(task.taskId)}
      onContextMenu={(e) => onCardContextMenu(e, task.taskId)}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelectTask(task.taskId); }}
    >
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
