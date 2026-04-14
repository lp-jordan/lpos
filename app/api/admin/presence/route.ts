import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getPresenceService } from '@/lib/services/container';
import { getUserById } from '@/lib/store/user-store';

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const clients = getPresenceService().getClients().map((entry) => {
    const user = getUserById(entry.userId);
    return {
      userId: entry.userId,
      name: user?.name ?? entry.userId,
      email: user?.email ?? null,
      connectedAt: entry.connectedAt,
      focused: entry.focused,
      lastFocusedAt: entry.lastFocusedAt,
      lastBlurredAt: entry.lastBlurredAt,
    };
  });

  return NextResponse.json({ clients });
}
