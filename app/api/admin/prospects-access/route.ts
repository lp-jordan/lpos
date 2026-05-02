import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRole, getSession } from '@/lib/services/api-auth';
import {
  getUsersWithProspectsAccess,
  grantProspectsAccess,
  revokeProspectsAccess,
} from '@/lib/store/prospect-access-store';
import { getUserById } from '@/lib/store/user-store';

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  return NextResponse.json({ users: getUsersWithProspectsAccess() });
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

  grantProspectsAccess(userId, session!.userId);
  return NextResponse.json({ users: getUsersWithProspectsAccess() });
}

export async function DELETE(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const body = await req.json() as { userId?: unknown };
  const userId = body.userId;

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId is required.' }, { status: 400 });
  }

  revokeProspectsAccess(userId);
  return NextResponse.json({ users: getUsersWithProspectsAccess() });
}
