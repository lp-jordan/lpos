import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { revokeEpToken } from '@/lib/store/ep-token-store';

type Ctx = { params: Promise<{ tokenId: string }> };

/**
 * POST /api/admin/ep-tokens/:tokenId/revoke
 * Marks the token revoked. Editpanel calls using it will start failing 401
 * immediately (next request) — there's no grace period.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const { tokenId } = await params;
  if (!tokenId) {
    return NextResponse.json({ error: 'tokenId is required' }, { status: 400 });
  }

  revokeEpToken(tokenId);
  return NextResponse.json({ ok: true });
}
