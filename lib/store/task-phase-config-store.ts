import { randomUUID } from 'node:crypto';
import type { TaskType, TaskTypeStatus } from '@/lib/models/task-phase';
import { getCoreDb, withTransaction } from './core-db';

/**
 * Dynamic per-task-type column configs. v21 introduces this for the
 * Pre-Production board, where admins create columns ad-hoc. Editing and
 * Platform stay on the static TASK_TYPE_CONFIGS in lib/models/task-phase.ts;
 * nothing in this file is consulted for them.
 *
 * Each column's `slug` is what gets stored in tasks.status — so reordering or
 * renaming a column doesn't touch existing task rows. Slugs are auto-generated
 * from the label on create and IMMUTABLE thereafter to avoid orphaning tasks.
 */

interface ConfigRow {
  config_id: string;
  task_type: string;
  slug: string;
  label: string;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PhaseConfig {
  configId: string;
  taskType: TaskType;
  slug: string;
  label: string;
  color: string;
  sortOrder: number;
}

function rowToConfig(row: ConfigRow): PhaseConfig {
  return {
    configId: row.config_id,
    taskType: row.task_type as TaskType,
    slug: row.slug,
    label: row.label,
    color: row.color,
    sortOrder: row.sort_order,
  };
}

export function getPhaseConfigsForType(taskType: TaskType): PhaseConfig[] {
  const rows = getCoreDb()
    .prepare(
      'SELECT * FROM task_phase_configs WHERE task_type = ? ORDER BY sort_order ASC, created_at ASC',
    )
    .all(taskType) as ConfigRow[];
  return rows.map(rowToConfig);
}

/** Shape consumed by TaskBoard / TaskDetailModal / NewTaskModal. */
export function getPhaseStatusesForType(taskType: TaskType): TaskTypeStatus[] {
  return getPhaseConfigsForType(taskType).map((c) => ({
    value: c.slug,
    label: c.label,
    color: c.color,
  }));
}

function slugify(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'col';
}

function makeUniqueSlug(taskType: TaskType, base: string): string {
  const db = getCoreDb();
  let slug = base;
  let n = 2;
  while (
    db.prepare('SELECT 1 FROM task_phase_configs WHERE task_type = ? AND slug = ?').get(taskType, slug)
  ) {
    slug = `${base}_${n++}`;
  }
  return slug;
}

export function createPhaseConfig(input: {
  taskType: TaskType;
  label: string;
  color: string;
}): PhaseConfig {
  const db = getCoreDb();
  const label = input.label.trim();
  if (!label) throw new Error('label is required');
  const now = new Date().toISOString();
  const slug = makeUniqueSlug(input.taskType, slugify(label));
  const max = db
    .prepare(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM task_phase_configs WHERE task_type = ?',
    )
    .get(input.taskType) as { m: number };
  const sortOrder = max.m + 1;
  const configId = randomUUID();
  db.prepare(
    `INSERT INTO task_phase_configs (config_id, task_type, slug, label, color, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(configId, input.taskType, slug, label, input.color, sortOrder, now, now);
  return { configId, taskType: input.taskType, slug, label, color: input.color, sortOrder };
}

export function updatePhaseConfig(
  configId: string,
  patch: { label?: string; color?: string },
): PhaseConfig | null {
  const db = getCoreDb();
  const row = db
    .prepare('SELECT * FROM task_phase_configs WHERE config_id = ?')
    .get(configId) as ConfigRow | undefined;
  if (!row) return null;
  const now = new Date().toISOString();
  const label = patch.label !== undefined ? patch.label.trim() || row.label : row.label;
  const color = patch.color || row.color;
  db.prepare(
    'UPDATE task_phase_configs SET label = ?, color = ?, updated_at = ? WHERE config_id = ?',
  ).run(label, color, now, configId);
  return rowToConfig({ ...row, label, color, updated_at: now });
}

export function deletePhaseConfig(configId: string): boolean {
  const result = getCoreDb()
    .prepare('DELETE FROM task_phase_configs WHERE config_id = ?')
    .run(configId);
  return (result as { changes: number }).changes > 0;
}

export function reorderPhaseConfigs(taskType: TaskType, configIdsInOrder: string[]): void {
  const db = getCoreDb();
  const now = new Date().toISOString();
  withTransaction(db, () => {
    for (let i = 0; i < configIdsInOrder.length; i++) {
      db.prepare(
        'UPDATE task_phase_configs SET sort_order = ?, updated_at = ? WHERE config_id = ? AND task_type = ?',
      ).run(i, now, configIdsInOrder[i], taskType);
    }
  });
}

/** How many tasks currently live on a given (taskType, status) column. Used by
 *  the column editor's delete-confirm step. */
export function countTasksInPhaseSlug(taskType: TaskType, slug: string): number {
  const row = getCoreDb()
    .prepare('SELECT COUNT(*) AS c FROM tasks WHERE task_type = ? AND status = ?')
    .get(taskType, slug) as { c: number };
  return row.c;
}

export function getPhaseConfigById(configId: string): PhaseConfig | null {
  const row = getCoreDb()
    .prepare('SELECT * FROM task_phase_configs WHERE config_id = ?')
    .get(configId) as ConfigRow | undefined;
  return row ? rowToConfig(row) : null;
}
