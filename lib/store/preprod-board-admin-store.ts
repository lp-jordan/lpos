import { getCoreDb } from './core-db';
import { getUserById, toUserSummary } from './user-store';
import type { UserSummary } from '@/lib/models/user';

/**
 * Per-feature access list: users who are allowed to add/rename/recolor/reorder/
 * delete columns on the Pre-Production task board. Mirrors prospect-access-store
 * and editpanel-access-store. Real admins always pass.
 */

export function canEditPreprodColumns(userId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  const row = getCoreDb()
    .prepare('SELECT 1 FROM preprod_board_admins WHERE user_id = ?')
    .get(userId);
  return row != null;
}

export function getUsersWithPreprodBoardAdmin(): UserSummary[] {
  const rows = getCoreDb()
    .prepare('SELECT user_id FROM preprod_board_admins ORDER BY granted_at ASC')
    .all() as { user_id: string }[];
  return rows
    .map((r) => toUserSummary(getUserById(r.user_id)))
    .filter(Boolean) as UserSummary[];
}

export function grantPreprodBoardAdmin(userId: string, grantedBy: string): void {
  const now = new Date().toISOString();
  getCoreDb()
    .prepare(
      'INSERT OR IGNORE INTO preprod_board_admins (user_id, granted_by, granted_at) VALUES (?, ?, ?)',
    )
    .run(userId, grantedBy, now);
}

export function revokePreprodBoardAdmin(userId: string): void {
  getCoreDb().prepare('DELETE FROM preprod_board_admins WHERE user_id = ?').run(userId);
}
