import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requirePreprodBoardAdmin } from '@/lib/services/api-auth';
import {
  getPhaseConfigsForType,
  reorderPhaseConfigs,
} from '@/lib/store/task-phase-config-store';

/**
 * Batch reorder. Body: { configIds: string[] } — the full preprod column list
 * in the desired order. Indices map to sort_order. Missing IDs are left alone
 * (their sort_order doesn't change).
 */

export async function POST(req: NextRequest) {
  const deny = await requirePreprodBoardAdmin(req);
  if (deny) return deny;

  const body = (await req.json()) as { configIds?: unknown };
  if (!Array.isArray(body.configIds) || body.configIds.some((id) => typeof id !== 'string')) {
    return NextResponse.json({ error: 'configIds must be an array of strings.' }, { status: 400 });
  }

  reorderPhaseConfigs('preprod', body.configIds as string[]);
  return NextResponse.json({ columns: getPhaseConfigsForType('preprod') });
}
