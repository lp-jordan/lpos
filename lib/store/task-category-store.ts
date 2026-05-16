import { randomUUID } from 'node:crypto';
import type { TaskCategory } from '@/lib/models/task-category';
import { getCoreDb, withTransaction } from './core-db';

interface CategoryRow {
  category_id: string;
  label: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function rowToCategory(row: CategoryRow): TaskCategory {
  return {
    categoryId: row.category_id,
    label: row.label,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskCategoryError extends Error {
  constructor(public code: 'duplicate' | 'not_found' | 'in_use', message: string) {
    super(message);
    this.name = 'TaskCategoryError';
  }
}

export class TaskCategoryStore {
  getAll(): TaskCategory[] {
    const rows = getCoreDb()
      .prepare(`SELECT * FROM task_categories ORDER BY sort_order ASC, created_at ASC`)
      .all() as CategoryRow[];
    return rows.map(rowToCategory);
  }

  getById(categoryId: string): TaskCategory | null {
    const row = getCoreDb()
      .prepare(`SELECT * FROM task_categories WHERE category_id = ?`)
      .get(categoryId) as CategoryRow | undefined;
    return row ? rowToCategory(row) : null;
  }

  /** Returns the existing category if the label collides (case-sensitive UNIQUE). */
  findByLabel(label: string): TaskCategory | null {
    const row = getCoreDb()
      .prepare(`SELECT * FROM task_categories WHERE label = ?`)
      .get(label.trim()) as CategoryRow | undefined;
    return row ? rowToCategory(row) : null;
  }

  /**
   * Create a new category. Sort order is set to (current max + 1) so new entries
   * land at the end of the list — admin can reorder afterwards.
   * Throws `TaskCategoryError('duplicate')` on label collision.
   */
  create(label: string): TaskCategory {
    const trimmed = label.trim();
    if (!trimmed) throw new TaskCategoryError('duplicate', 'Category label cannot be empty.');

    const db = getCoreDb();
    if (this.findByLabel(trimmed)) {
      throw new TaskCategoryError('duplicate', `A category named "${trimmed}" already exists.`);
    }

    const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM task_categories`).get() as { max_sort: number };
    const category: TaskCategory = {
      categoryId: randomUUID(),
      label: trimmed,
      sortOrder: maxRow.max_sort + 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    db.prepare(
      `INSERT INTO task_categories (category_id, label, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(category.categoryId, category.label, category.sortOrder, category.createdAt, category.updatedAt);

    return category;
  }

  /**
   * Rename. Cascades to tasks: any task currently tagged with the old label gets
   * its `category` column updated to the new label in the same transaction.
   * Throws `not_found` if the category doesn't exist, `duplicate` if the new label
   * collides with another existing category.
   */
  rename(categoryId: string, newLabel: string): TaskCategory {
    const trimmed = newLabel.trim();
    if (!trimmed) throw new TaskCategoryError('duplicate', 'Category label cannot be empty.');

    const db = getCoreDb();
    const existing = this.getById(categoryId);
    if (!existing) throw new TaskCategoryError('not_found', 'Category not found.');
    if (existing.label === trimmed) return existing;

    const collision = this.findByLabel(trimmed);
    if (collision && collision.categoryId !== categoryId) {
      throw new TaskCategoryError('duplicate', `A category named "${trimmed}" already exists.`);
    }

    const now = new Date().toISOString();
    withTransaction(db, () => {
      db.prepare(`UPDATE task_categories SET label = ?, updated_at = ? WHERE category_id = ?`)
        .run(trimmed, now, categoryId);
      // Cascade label change to tasks. Tasks reference category by label (not id),
      // so this rename has to update every task whose category string matches.
      db.prepare(`UPDATE tasks SET category = ? WHERE category = ?`).run(trimmed, existing.label);
    });

    return { ...existing, label: trimmed, updatedAt: now };
  }

  /**
   * Replace the full ordering. `orderedIds` should contain every category id in
   * the desired order. Anything missing keeps its current sort_order. The reorder
   * is transactional.
   */
  reorder(orderedIds: string[]): TaskCategory[] {
    const db = getCoreDb();
    withTransaction(db, () => {
      const update = db.prepare(`UPDATE task_categories SET sort_order = ?, updated_at = ? WHERE category_id = ?`);
      const now = new Date().toISOString();
      orderedIds.forEach((id, idx) => update.run(idx, now, id));
    });
    return this.getAll();
  }

  /**
   * Delete. Blocked if any task currently references the category label — admin
   * must reassign those tasks first (no silent orphan/merge). Throws `in_use`
   * with a count when blocked.
   */
  remove(categoryId: string): void {
    const db = getCoreDb();
    const existing = this.getById(categoryId);
    if (!existing) throw new TaskCategoryError('not_found', 'Category not found.');

    const usageRow = db.prepare(`SELECT COUNT(*) AS cnt FROM tasks WHERE category = ?`)
      .get(existing.label) as { cnt: number };
    if (usageRow.cnt > 0) {
      throw new TaskCategoryError(
        'in_use',
        `Cannot delete "${existing.label}" — ${usageRow.cnt} task${usageRow.cnt === 1 ? '' : 's'} still use${usageRow.cnt === 1 ? 's' : ''} it. Reassign or delete those tasks first.`,
      );
    }

    db.prepare(`DELETE FROM task_categories WHERE category_id = ?`).run(categoryId);
  }
}
