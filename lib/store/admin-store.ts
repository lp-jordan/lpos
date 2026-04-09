/**
 * Admin email list
 *
 * The bootstrap admin (LPOS_BOOTSTRAP_ADMIN env or the hardcoded fallback) is
 * always treated as admin regardless of the persisted list. Additional admins
 * are stored in the `admins` table of lpos-core.sqlite and can be managed via
 * the settings UI.
 *
 * The bootstrap admin cannot be removed through the API.
 */

import { getCoreDb } from '@/lib/store/core-db';

export const BOOTSTRAP_ADMIN = (
  process.env.LPOS_BOOTSTRAP_ADMIN?.trim().toLowerCase() || 'jordan@leaderpass.com'
);

function readAdditional(): string[] {
  const db = getCoreDb();
  const rows = db.prepare('SELECT email FROM admins').all() as { email: string }[];
  return rows.map((r) => r.email);
}

/** True if the given email holds admin access. */
export function isAdminEmail(email: string): boolean {
  if (!email) return false;
  const normalised = email.toLowerCase();
  if (normalised === BOOTSTRAP_ADMIN) return true;
  const db = getCoreDb();
  const row = db.prepare('SELECT 1 FROM admins WHERE email = ?').get(normalised) as unknown;
  return row != null;
}

/** Full list of admin emails (bootstrap first, then additional). */
export function getAdmins(): string[] {
  const additional = readAdditional().filter((e) => e !== BOOTSTRAP_ADMIN);
  return [BOOTSTRAP_ADMIN, ...additional];
}

/** Add an admin by email. No-op if already in the list. Returns the updated list. */
export function addAdmin(email: string): string[] {
  const normalised = email.toLowerCase().trim();
  if (!normalised) throw new Error('Email must not be empty.');
  if (normalised === BOOTSTRAP_ADMIN) return getAdmins();
  const db = getCoreDb();
  db.prepare('INSERT OR IGNORE INTO admins (email) VALUES (?)').run(normalised);
  return getAdmins();
}

/**
 * Remove an admin by email. Throws if caller tries to remove the bootstrap
 * admin. Returns the updated list.
 */
export function removeAdmin(email: string): string[] {
  const normalised = email.toLowerCase().trim();
  if (normalised === BOOTSTRAP_ADMIN) {
    throw new Error('The primary admin account cannot be removed.');
  }
  const db = getCoreDb();
  db.prepare('DELETE FROM admins WHERE email = ?').run(normalised);
  return getAdmins();
}
