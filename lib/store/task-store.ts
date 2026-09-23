import { randomUUID } from 'node:crypto';
import type { Task, TaskPriority } from '@/lib/models/task';
import type { TaskType } from '@/lib/models/task-phase';
import { getCoreDb, withTransaction } from './core-db';

interface TaskRow {
  task_id: string;
  description: string;
  client_name: string;
  task_type: string;
  category: string | null;
  priority: string;
  status: string;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  schedule_order: number | null;
  calendar_visible: number | null;
}

/** Schedule fields move as a unit — a partial patch would let start and end drift. */
export interface TaskSchedulePatch {
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduleOrder?: number;
}

/** null clears the override and returns the task to the default rule. */
export interface TaskCalendarVisibilityPatch {
  calendarVisible: boolean | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Collapse any schedule input to the two invariants the calendar relies on:
 * start and end are both set or both null, and end is never before start.
 * Anything malformed unschedules rather than persisting a half-state — a bar
 * that can't be positioned is worse than one sitting in the unscheduled rail.
 */
function normalizeSchedule(start: string | null | undefined, end: string | null | undefined): { start: string | null; end: string | null } {
  const s = typeof start === 'string' && ISO_DAY.test(start) ? start : null;
  if (!s) return { start: null, end: null };
  const e = typeof end === 'string' && ISO_DAY.test(end) ? end : s;
  // Lexicographic comparison is chronological for zero-padded ISO days.
  return e < s ? { start: s, end: s } : { start: s, end: e };
}

interface AssigneeRow {
  task_id: string;
  user_id: string;
}

function rowToTask(row: TaskRow, assignedTo: string[]): Task {
  return {
    taskId: row.task_id,
    description: row.description,
    clientName: row.client_name,
    taskType: row.task_type as TaskType,
    category: row.category ?? null,
    priority: row.priority as TaskPriority,
    status: row.status,
    createdBy: row.created_by,
    assignedTo,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    scheduledStart: row.scheduled_start ?? null,
    scheduledEnd: row.scheduled_end ?? null,
    scheduleOrder: row.schedule_order ?? 0,
    calendarVisible: row.calendar_visible === null || row.calendar_visible === undefined
      ? null
      : row.calendar_visible === 1,
  };
}

function buildAssigneeMap(rows: AssigneeRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const arr = map.get(row.task_id) ?? [];
    arr.push(row.user_id);
    map.set(row.task_id, arr);
  }
  return map;
}

function getAssigneesForTask(taskId: string): string[] {
  return (getCoreDb().prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(taskId) as { user_id: string }[])
    .map((r) => r.user_id);
}

export class TaskStore {
  // ── Read ─────────────────────────────────────────────────────────────────

  getAll(): Task[] {
    const db = getCoreDb();
    const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as TaskRow[];
    if (rows.length === 0) return [];
    const assigneeMap = buildAssigneeMap(db.prepare('SELECT task_id, user_id FROM task_assignees').all() as AssigneeRow[]);
    return rows.map((row) => rowToTask(row, assigneeMap.get(row.task_id) ?? []));
  }

  getForUser(userId: string): Task[] {
    const db = getCoreDb();
    const rows = db.prepare(`
      SELECT DISTINCT t.* FROM tasks t
      LEFT JOIN task_assignees ta ON t.task_id = ta.task_id
      WHERE t.created_by = ? OR ta.user_id = ?
      ORDER BY t.created_at DESC
    `).all(userId, userId) as TaskRow[];
    return rows.map((row) => rowToTask(row, getAssigneesForTask(row.task_id)));
  }

  getById(taskId: string): Task | null {
    const row = getCoreDb().prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined;
    if (!row) return null;
    return rowToTask(row, getAssigneesForTask(taskId));
  }

  // ── Write ────────────────────────────────────────────────────────────────

  create(input: {
    description: string;
    clientName?: string;
    taskType: TaskType;
    category?: string | null;
    priority?: TaskPriority;
    status?: string;
    createdBy: string;
    assignedTo?: string[];
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
  }): Task {
    const db = getCoreDb();
    // Category only applies to Platform tasks; ignore any value passed for Editing.
    const category = input.taskType === 'platform' ? (input.category?.trim() || null) : null;
    const sched = normalizeSchedule(input.scheduledStart, input.scheduledEnd);
    const task: Task = {
      taskId: randomUUID(),
      description: input.description.trim(),
      clientName: input.clientName?.trim() || 'General',
      taskType: input.taskType,
      category,
      priority: input.priority ?? 'medium',
      status: input.status ?? 'not_started',
      createdBy: input.createdBy,
      assignedTo: input.assignedTo?.length ? input.assignedTo : [input.createdBy],
      createdAt: new Date().toISOString(),
      scheduledStart: sched.start,
      scheduledEnd: sched.end,
      scheduleOrder: 0,
      calendarVisible: null,
    };

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (task_id, description, client_name, task_type, category, priority, status, created_by, created_at, scheduled_start, scheduled_end, schedule_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(task.taskId, task.description, task.clientName, task.taskType, task.category, task.priority, task.status, task.createdBy, task.createdAt, task.scheduledStart, task.scheduledEnd, task.scheduleOrder);

      for (const userId of task.assignedTo) {
        db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(task.taskId, userId);
      }
    });

    return task;
  }

  update(
    taskId: string,
    patch: Partial<Pick<Task, 'status' | 'description' | 'assignedTo' | 'priority' | 'taskType' | 'clientName' | 'category'>>
      & Partial<TaskSchedulePatch>
      & Partial<TaskCalendarVisibilityPatch>,
  ): Task | null {
    const db = getCoreDb();
    const existing = this.getById(taskId);
    if (!existing) return null;

    const nextStatus = patch.status ?? existing.status;
    const completedAt =
      nextStatus === 'done' && existing.status !== 'done'
        ? new Date().toISOString()
        : nextStatus !== 'done'
          ? null
          : (existing.completedAt ?? null);

    const next: Task = {
      ...existing,
      ...patch,
      completedAt: completedAt ?? undefined,
    };
    // Editing tasks force-null the category — switching a Platform task back to
    // Editing should clear the category rather than carry it as orphan metadata.
    const nextCategory = next.taskType === 'platform' ? (next.category ?? null) : null;

    // Schedule only moves when the caller actually sent scheduledStart; a patch
    // that omits it (a status change, a rename) must leave the calendar alone.
    const sched = patch.scheduledStart !== undefined
      ? normalizeSchedule(patch.scheduledStart, patch.scheduledEnd)
      : { start: existing.scheduledStart, end: existing.scheduledEnd };
    const scheduleOrder = patch.scheduleOrder ?? existing.scheduleOrder;
    // undefined means "leave alone"; null means "clear back to the default rule".
    const calendarVisible = patch.calendarVisible !== undefined
      ? patch.calendarVisible
      : existing.calendarVisible;

    withTransaction(db, () => {
      db.prepare(
        `UPDATE tasks SET description = ?, task_type = ?, category = ?, priority = ?, status = ?, completed_at = ?, client_name = ?,
                scheduled_start = ?, scheduled_end = ?, schedule_order = ?, calendar_visible = ?
         WHERE task_id = ?`,
      ).run(next.description, next.taskType, nextCategory, next.priority, next.status, completedAt, next.clientName, sched.start, sched.end, scheduleOrder, calendarVisible === null ? null : (calendarVisible ? 1 : 0), taskId);

      if (patch.assignedTo !== undefined) {
        db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(taskId);
        for (const userId of next.assignedTo) {
          db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(taskId, userId);
        }
      }
    });

    return { ...next, category: nextCategory, scheduledStart: sched.start, scheduledEnd: sched.end, scheduleOrder, calendarVisible };
  }

  delete(taskId: string): boolean {
    const result = getCoreDb().prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
    return (result as { changes: number }).changes > 0;
  }
}
