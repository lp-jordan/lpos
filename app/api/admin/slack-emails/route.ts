import { type NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getAllUsers } from '@/lib/store/user-store';

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const users = getAllUsers().map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    slackEmail: u.slackEmail,
  }));

  return NextResponse.json({ users });
}
