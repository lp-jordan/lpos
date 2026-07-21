import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireHiringAccess } from '@/lib/services/require-hiring-access';
import { updateInvite, HiringError } from '@/lib/services/hiring-service';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const deny = await requireHiringAccess(req);
  if (deny) return deny;

  const { token } = await ctx.params;
  const body = await req.json() as { revoked?: unknown; archived?: unknown };

  const patch: { revoked?: boolean; archived?: boolean } = {};
  if (typeof body.revoked === 'boolean')  patch.revoked  = body.revoked;
  if (typeof body.archived === 'boolean') patch.archived = body.archived;
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  try {
    await updateInvite(token, patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = err as HiringError;
    return NextResponse.json({ error: e.message }, { status: e.status ?? 500 });
  }
}
