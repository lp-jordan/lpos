import { getCoreDb } from './core-db';
import { getUserById, getAllUsers, toUserSummary } from './user-store';
import { hasProspectsAccess } from './prospect-access-store';
import { isAdminEmail } from './admin-store';
import type { UserSummary } from '@/lib/models/user';

/**
 * People access as it actually resolves for a user, independent of the current
 * request's session. Admins pass implicitly, which is why the eligible list
 * below cannot just read the `prospect_access` table — an admin typically has
 * no row there but plainly holds People access.
 */
function holdsPeopleAccess(userId: string, email: string): boolean {
  return hasProspectsAccess(userId, isAdminEmail(email));
}

/**
 * Hiring access is a strict subset of People access.
 *
 * Two things make this different from every other gate in LPOS:
 *
 *  1. **Admin is not sufficient.** LPOS "admin" means system administration,
 *     not HR authority. Candidate assessments are grantable explicitly, to
 *     yourself included.
 *  2. **The nesting is enforced at read time**, not just in the settings
 *     dropdown, so a stale grant row cannot outlive its parent permission.
 *     Revoking People access also deletes the row (see
 *     `revokeProspectsAccess`), but the read-time check is the backstop.
 */
export function hasHiringAccess(userId: string, isAdmin: boolean): boolean {
  if (!hasProspectsAccess(userId, isAdmin)) return false;
  const row = getCoreDb().prepare('SELECT 1 FROM hiring_access WHERE user_id = ?').get(userId);
  return row != null;
}

/**
 * Users holding a hiring grant AND still holding People access. A row whose
 * parent permission was revoked is filtered out rather than shown as active.
 */
export function getUsersWithHiringAccess(): UserSummary[] {
  const rows = getCoreDb()
    .prepare('SELECT user_id FROM hiring_access ORDER BY granted_at ASC')
    .all() as { user_id: string }[];

  return rows
    .map((r) => {
      const user = getUserById(r.user_id);
      if (!user) return null;
      if (!holdsPeopleAccess(user.id, user.email)) return null;
      return toUserSummary(user);
    })
    .filter(Boolean) as UserSummary[];
}

/**
 * Candidates for a grant: only users who already hold People access. This is
 * why the panel's dropdown differs from `ProspectsAccessPanel`, which draws
 * from all users — you cannot grant the narrower permission to someone who
 * lacks the broader one.
 */
export function getUsersEligibleForHiringAccess(): UserSummary[] {
  const granted = new Set(getUsersWithHiringAccess().map((u) => u.id));
  return getAllUsers()
    .filter((u) => !granted.has(u.id) && holdsPeopleAccess(u.id, u.email))
    .map(toUserSummary)
    .filter((u): u is UserSummary => u !== null && !u.isGuest);
}

export function grantHiringAccess(userId: string, grantedBy: string): void {
  const now = new Date().toISOString();
  getCoreDb()
    .prepare('INSERT OR IGNORE INTO hiring_access (user_id, granted_by, granted_at) VALUES (?, ?, ?)')
    .run(userId, grantedBy, now);
}

export function revokeHiringAccess(userId: string): void {
  getCoreDb().prepare('DELETE FROM hiring_access WHERE user_id = ?').run(userId);
}
