import { randomUUID } from 'node:crypto';
import type { WishItem } from '@/lib/models/wish';
import { getCoreDb } from './core-db';

interface WishRow {
  wish_id: string;
  title: string;
  description: string | null;
  submitted_by: string;
  submitted_by_name: string;
  completed: number;
  created_at: string;
  completed_at: string | null;
}

function rowToWish(row: WishRow): WishItem {
  return {
    wishId: row.wish_id,
    title: row.title,
    description: row.description ?? undefined,
    submittedBy: row.submitted_by,
    submittedByName: row.submitted_by_name,
    completed: row.completed === 1,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export class WishStore {
  // ── Read ─────────────────────────────────────────────────────────────────

  getAll(): WishItem[] {
    return (getCoreDb().prepare('SELECT * FROM wishes ORDER BY created_at DESC').all() as WishRow[]).map(rowToWish);
  }

  getById(wishId: string): WishItem | null {
    const row = getCoreDb().prepare('SELECT * FROM wishes WHERE wish_id = ?').get(wishId) as WishRow | undefined;
    return row ? rowToWish(row) : null;
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  create(input: {
    title: string;
    description?: string;
    submittedBy: string;
    submittedByName: string;
  }): WishItem {
    const wish: WishItem = {
      wishId: randomUUID(),
      title: input.title.trim(),
      description: input.description?.trim() || undefined,
      submittedBy: input.submittedBy,
      submittedByName: input.submittedByName,
      completed: false,
      createdAt: new Date().toISOString(),
    };

    getCoreDb().prepare(
      `INSERT INTO wishes (wish_id, title, description, submitted_by, submitted_by_name, completed, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run(wish.wishId, wish.title, wish.description ?? null, wish.submittedBy, wish.submittedByName, wish.createdAt);

    return wish;
  }

  update(wishId: string, patch: Partial<Pick<WishItem, 'completed'>>): WishItem | null {
    const db = getCoreDb();
    const existing = this.getById(wishId);
    if (!existing) return null;

    const completedAt =
      patch.completed === true && !existing.completed
        ? new Date().toISOString()
        : patch.completed === false
          ? null
          : (existing.completedAt ?? null);

    const next: WishItem = {
      ...existing,
      ...patch,
      completedAt: completedAt ?? undefined,
    };

    db.prepare(
      'UPDATE wishes SET completed = ?, completed_at = ? WHERE wish_id = ?',
    ).run(next.completed ? 1 : 0, completedAt, wishId);

    return next;
  }

  delete(wishId: string): boolean {
    const result = getCoreDb().prepare('DELETE FROM wishes WHERE wish_id = ?').run(wishId);
    return (result as { changes: number }).changes > 0;
  }
}
