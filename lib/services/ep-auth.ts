/**
 * EditPanel auth middleware
 *
 * Replaces the old shared-secret model. Every /api/ep/* request must carry
 * an X-EP-Token header. Tokens are minted via the /ep/link approval flow
 * (see lib/store/ep-token-store.ts) and stored hashed in the ep_tokens table.
 *
 * Usage:
 *   const auth = requireEpToken(req);
 *   if (auth instanceof NextResponse) return auth;   // 401
 *   const { user, role, tokenId } = auth;
 */

import { NextRequest, NextResponse } from 'next/server';
import type { User, UserRole } from '@/lib/models/user';
import { verifyEpToken, touchEpToken } from '@/lib/store/ep-token-store';
import { getUserById } from '@/lib/store/user-store';
import { isAdminEmail } from '@/lib/store/admin-store';

export interface EpAuthContext {
  user:    User;
  role:    UserRole;
  tokenId: string;
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

/**
 * Verify the X-EP-Token header on the request.
 * Returns an EpAuthContext on success, or a 401 NextResponse on failure.
 */
export function requireEpToken(req: NextRequest): EpAuthContext | NextResponse {
  const raw = req.headers.get('x-ep-token')?.trim();
  const row = verifyEpToken(raw);
  if (!row) return unauthorized('Invalid or revoked EditPanel token');

  const user = getUserById(row.userId);
  if (!user) return unauthorized('Token user no longer exists');

  // Last-used hint for the admin Connected Devices page. Cheap UPDATE; fine on
  // every request (including 10s heartbeat — see ep/status route).
  touchEpToken(row.tokenId);

  const role: UserRole = isAdminEmail(user.email) ? 'admin' : 'user';
  return { user, role, tokenId: row.tokenId };
}
