import { getCoreDb } from './core-db';
import { getUserById, toUserSummary } from './user-store';
import type { UserSummary } from '@/lib/models/user';

/**
 * Per-user grant controlling whether a user sees the EditPanel download icon on
 * the home screen (a shortcut to /ep-update). Purely a UI-visibility gate — the
 * /ep-update page and /api/ep-updates/* downloads stay publicly reachable.
 * Mirrors prospect-access-store. Admins always have access.
 */

export function hasEditpanelAccess(userId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  const row = getCoreDb().prepare('SELECT 1 FROM editpanel_access WHERE user_id = ?').get(userId);
  return row != null;
}

export function getUsersWithEditpanelAccess(): UserSummary[] {
  const rows = getCoreDb()
    .prepare('SELECT user_id FROM editpanel_access ORDER BY granted_at ASC')
    .all() as { user_id: string }[];
  return rows
    .map((r) => toUserSummary(getUserById(r.user_id)))
    .filter(Boolean) as UserSummary[];
}

export function grantEditpanelAccess(userId: string, grantedBy: string): void {
  const now = new Date().toISOString();
  getCoreDb()
    .prepare('INSERT OR IGNORE INTO editpanel_access (user_id, granted_by, granted_at) VALUES (?, ?, ?)')
    .run(userId, grantedBy, now);
}

export function revokeEditpanelAccess(userId: string): void {
  getCoreDb().prepare('DELETE FROM editpanel_access WHERE user_id = ?').run(userId);
}
