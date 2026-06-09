import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRole, getSession } from '@/lib/services/api-auth';
import {
  getUsersWithPreprodBoardAdmin,
  grantPreprodBoardAdmin,
  revokePreprodBoardAdmin,
} from '@/lib/store/preprod-board-admin-store';
import { getUserById } from '@/lib/store/user-store';

/**
 * Admin-only CRUD on the per-user access list for Pre-Production board column
 * editing. Mirrors /api/admin/prospects-access.
 */

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;
  return NextResponse.json({ users: getUsersWithPreprodBoardAdmin() });
}

export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const session = await getSession(req);
  const body = await req.json() as { userId?: unknown };
  const userId = body.userId;

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId is required.' }, { status: 400 });
  }

  const user = getUserById(userId);
  if (!user) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  grantPreprodBoardAdmin(userId, session!.userId);
  return NextResponse.json({ users: getUsersWithPreprodBoardAdmin() });
}

export async function DELETE(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const body = await req.json() as { userId?: unknown };
  const userId = body.userId;

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId is required.' }, { status: 400 });
  }

  revokePreprodBoardAdmin(userId);
  return NextResponse.json({ users: getUsersWithPreprodBoardAdmin() });
}
