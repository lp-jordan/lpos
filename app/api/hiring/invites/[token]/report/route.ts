import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireHiringAccess } from '@/lib/services/require-hiring-access';
import { getReport, HiringError } from '@/lib/services/hiring-service';

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const deny = await requireHiringAccess(req);
  if (deny) return deny;

  const { token } = await ctx.params;
  try {
    return NextResponse.json(await getReport(token));
  } catch (err) {
    const e = err as HiringError;
    return NextResponse.json({ error: e.message }, { status: e.status ?? 500 });
  }
}
