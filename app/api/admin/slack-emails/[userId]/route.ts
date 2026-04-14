import { type NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getUserById, setSlackEmail } from '@/lib/store/user-store';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const { userId } = await params;
  const user = getUserById(userId);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const body = await req.json() as { slackEmail?: string | null };
  const slackEmail = body.slackEmail?.trim() || null;

  setSlackEmail(userId, slackEmail);
  return NextResponse.json({ ok: true, slackEmail });
}
