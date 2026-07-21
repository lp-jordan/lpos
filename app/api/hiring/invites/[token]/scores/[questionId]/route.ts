import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/services/api-auth';
import { requireHiringAccess } from '@/lib/services/require-hiring-access';
import { saveScore, HiringError } from '@/lib/services/hiring-service';
import { getUserById } from '@/lib/store/user-store';

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ token: string; questionId: string }> },
) {
  const deny = await requireHiringAccess(req);
  if (deny) return deny;

  const { token, questionId } = await ctx.params;
  const session = await getSession(req);
  const body = await req.json() as Record<string, unknown>;

  try {
    await saveScore(token, questionId, {
      ...body,
      scoredBy: (session ? getUserById(session.userId)?.email : null) ?? session?.userId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = err as HiringError;
    return NextResponse.json({ error: e.message }, { status: e.status ?? 500 });
  }
}
