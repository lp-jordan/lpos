import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRole, getSession } from '@/lib/services/api-auth';
import {
  getUsersWithHiringAccess,
  getUsersEligibleForHiringAccess,
  grantHiringAccess,
  revokeHiringAccess,
} from '@/lib/store/hiring-access-store';
import { getUserById } from '@/lib/store/user-store';
import { hasProspectsAccess } from '@/lib/store/prospect-access-store';
import { isAdminEmail } from '@/lib/store/admin-store';

/** Both lists in one payload — the panel's dropdown is derived, not all users. */
function payload() {
  return {
    users: getUsersWithHiringAccess(),
    eligible: getUsersEligibleForHiringAccess(),
  };
}

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  return NextResponse.json(payload());
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

  // Enforce the nesting on write as well as on read. The panel only offers
  // eligible users, but a hand-rolled request must not be able to create a
  // hiring grant that has no parent People access to sit under.
  if (!hasProspectsAccess(user.id, isAdminEmail(user.email))) {
    return NextResponse.json(
      { error: 'Grant People access first — hiring access sits underneath it.' },
      { status: 400 },
    );
  }

  grantHiringAccess(userId, session!.userId);
  return NextResponse.json(payload());
}

export async function DELETE(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const body = await req.json() as { userId?: unknown };
  const userId = body.userId;

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId is required.' }, { status: 400 });
  }

  revokeHiringAccess(userId);
  return NextResponse.json(payload());
}
