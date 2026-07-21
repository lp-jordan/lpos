import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireHiringAccess } from '@/lib/services/require-hiring-access';
import { listQuestionnaires, HiringError } from '@/lib/services/hiring-service';

export async function GET(req: NextRequest) {
  const deny = await requireHiringAccess(req);
  if (deny) return deny;

  try {
    return NextResponse.json({ questionnaires: await listQuestionnaires() });
  } catch (err) {
    const e = err as HiringError;
    return NextResponse.json({ error: e.message }, { status: e.status ?? 500 });
  }
}
