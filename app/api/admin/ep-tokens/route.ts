import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { listAllEpTokens } from '@/lib/store/ep-token-store';
import { getUserById } from '@/lib/store/user-store';

/**
 * GET /api/admin/ep-tokens
 *
 * Returns every editpanel token (active + revoked) with the bound user's
 * email + name resolved for display. Powers the Connected EditPanel devices
 * admin panel.
 */
export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const rows = listAllEpTokens().map((t) => {
    const user = getUserById(t.userId);
    return {
      tokenId:     t.tokenId,
      machineName: t.machineName,
      createdAt:   t.createdAt,
      lastUsedAt:  t.lastUsedAt,
      revokedAt:   t.revokedAt,
      user: user
        ? { id: user.id, email: user.email, name: user.name }
        : { id: t.userId, email: '(deleted user)', name: '' },
    };
  });

  return NextResponse.json({ tokens: rows });
}
