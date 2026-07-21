import { getCoreDb } from './core-db';
import { getUserById, toUserSummary } from './user-store';
import type { UserSummary } from '@/lib/models/user';

export function hasProspectsAccess(userId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  const row = getCoreDb().prepare('SELECT 1 FROM prospect_access WHERE user_id = ?').get(userId);
  return row != null;
}

export function getUsersWithProspectsAccess(): UserSummary[] {
  const rows = getCoreDb()
    .prepare('SELECT user_id FROM prospect_access ORDER BY granted_at ASC')
    .all() as { user_id: string }[];
  return rows
    .map((r) => toUserSummary(getUserById(r.user_id)))
    .filter(Boolean) as UserSummary[];
}

export function grantProspectsAccess(userId: string, grantedBy: string): void {
  const now = new Date().toISOString();
  getCoreDb()
    .prepare('INSERT OR IGNORE INTO prospect_access (user_id, granted_by, granted_at) VALUES (?, ?, ?)')
    .run(userId, grantedBy, now);
}

export function revokeProspectsAccess(userId: string): void {
  const db = getCoreDb();
  db.prepare('DELETE FROM prospect_access WHERE user_id = ?').run(userId);
  // Hiring access is a strict subset of People access, so revoking the parent
  // cascades. Without this, re-granting People access later would silently
  // restore access to the more sensitive tier. Kept here rather than in
  // hiring-access-store to avoid a circular import; the read-time nesting check
  // in hasHiringAccess is the backstop if this is ever bypassed.
  db.prepare('DELETE FROM hiring_access WHERE user_id = ?').run(userId);
}
