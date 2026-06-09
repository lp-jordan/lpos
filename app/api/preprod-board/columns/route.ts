import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRole, requirePreprodBoardAdmin } from '@/lib/services/api-auth';
import {
  createPhaseConfig,
  getPhaseConfigsForType,
} from '@/lib/store/task-phase-config-store';

/**
 * GET — any authenticated user can read the column list (drives the kanban UI).
 * POST — restricted to admins + users in preprod_board_admins.
 */

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  return NextResponse.json({ columns: getPhaseConfigsForType('preprod') });
}

export async function POST(req: NextRequest) {
  const deny = await requirePreprodBoardAdmin(req);
  if (deny) return deny;

  const body = (await req.json()) as { label?: unknown; color?: unknown };
  if (typeof body.label !== 'string' || !body.label.trim()) {
    return NextResponse.json({ error: 'label is required.' }, { status: 400 });
  }
  if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
    return NextResponse.json({ error: 'color must be a hex string like #aabbcc.' }, { status: 400 });
  }

  const created = createPhaseConfig({
    taskType: 'preprod',
    label: body.label,
    color: body.color,
  });
  return NextResponse.json({ column: created, columns: getPhaseConfigsForType('preprod') }, { status: 201 });
}
