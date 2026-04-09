import { randomUUID } from 'node:crypto';
import type { Task, TaskPriority, TaskStatus } from '@/lib/models/task';
import { getCoreDb, withTransaction } from './core-db';

interface TaskRow {
  task_id: string;
  description: string;
  project_id: string;
  client_name: string | null;
  priority: string;
  status: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
}

interface AssigneeRow {
  task_id: string;
  user_id: string;
}

function rowToTask(row: TaskRow, assignedTo: string[]): Task {
  return {
    taskId: row.task_id,
    description: row.description,
    projectId: row.project_id,
    clientName: row.client_name ?? null,
    priority: row.priority as TaskPriority,
    status: row.status as TaskStatus,
    notes: row.notes ?? null,
    createdBy: row.created_by,
    assignedTo,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
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
    projectId: string;
    clientName?: string | null;
    priority?: TaskPriority;
    status?: TaskStatus;
    notes?: string | null;
    createdBy: string;
    assignedTo?: string[];
  }): Task {
    const db = getCoreDb();
    const task: Task = {
      taskId: randomUUID(),
      description: input.description.trim(),
      projectId: input.projectId,
      clientName: input.clientName ?? null,
      priority: input.priority ?? 'medium',
      status: input.status ?? 'not_started',
      notes: input.notes ?? null,
      createdBy: input.createdBy,
      assignedTo: input.assignedTo?.length ? input.assignedTo : [input.createdBy],
      createdAt: new Date().toISOString(),
    };

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (task_id, description, project_id, client_name, priority, status, notes, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(task.taskId, task.description, task.projectId, task.clientName, task.priority, task.status, task.notes, task.createdBy, task.createdAt);

      for (const userId of task.assignedTo) {
        db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(task.taskId, userId);
      }
    });

    return task;
  }

  update(
    taskId: string,
    patch: Partial<Pick<Task, 'status' | 'description' | 'assignedTo' | 'priority' | 'notes'>>,
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

    withTransaction(db, () => {
      db.prepare(
        `UPDATE tasks SET description = ?, priority = ?, status = ?, notes = ?, completed_at = ?
         WHERE task_id = ?`,
      ).run(next.description, next.priority, next.status, next.notes, completedAt, taskId);

      if (patch.assignedTo !== undefined) {
        db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(taskId);
        for (const userId of next.assignedTo) {
          db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(taskId, userId);
        }
      }
    });

    return next;
  }

  delete(taskId: string): boolean {
    const result = getCoreDb().prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
    return (result as { changes: number }).changes > 0;
  }
}
