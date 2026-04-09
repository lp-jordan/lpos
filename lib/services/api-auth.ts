/**
 * Route-level auth helpers
 *
 * Use these at the top of any API route handler that requires a specific role.
 *
 * Usage:
 *   const deny = await requireRole(req, 'admin');
 *   if (deny) return deny;
 *
 * Role hierarchy (each level includes the levels below it in terms of access):
 *   admin  — full access, including destructive/configuration operations
 *   user   — authenticated operator; can read and write project data
 *   guest  — studio client; read-only, restricted to allowed paths
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import type { UserRole } from '@/lib/models/user';

const ROLE_RANK: Record<UserRole, number> = { guest: 0, user: 1, admin: 2 };

/**
 * Returns a 401/403 NextResponse if the request does not hold at least
 * `minimumRole`. Returns null if access is allowed — caller should proceed.
 */
export async function requireRole(
  req: NextRequest,
  minimumRole: UserRole,
): Promise<NextResponse | null> {
  const session = await verifySessionToken(req.cookies.get(APP_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  }
  if (ROLE_RANK[session.role] < ROLE_RANK[minimumRole]) {
    return NextResponse.json({ error: 'You do not have permission to do that.' }, { status: 403 });
  }
  return null;
}

/** Convenience wrapper — resolves the session and returns it, or null. */
export async function getSession(req: NextRequest) {
  return verifySessionToken(req.cookies.get(APP_SESSION_COOKIE)?.value);
}
