import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getPresenceService } from '@/lib/services/container';
import { getUserById } from '@/lib/store/user-store';

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  // One row per user, collapsing every tab/socket that user has open.
  const users = getPresenceService().getUsers().map((entry) => {
    const user = getUserById(entry.userId);
    return {
      userId: entry.userId,
      name: user?.name ?? entry.userId,
      email: user?.email ?? null,
      focused: entry.focused,
      tabCount: entry.tabCount,
      connectedAt: entry.connectedAt,
      lastFocusedAt: entry.lastFocusedAt,
      lastSeenAt: entry.lastSeenAt,
    };
  });

  return NextResponse.json({ users });
}
