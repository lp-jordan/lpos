/**
 * POST /api/task-categories/reorder — replace the full sort order.
 * Body: { orderedIds: string[] } — every category id in the desired final order.
 *
 * Gated to `user` (not `admin`) — reordering is cosmetic, not destructive.
 * Create/rename/delete remain admin-only on the sibling routes. Any signed-in
 * non-guest user can drag-reorder categories from the platform list view.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getTaskCategoryStore } from '@/lib/services/container';

export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;

  const body = await req.json().catch(() => ({})) as { orderedIds?: string[] };
  if (!Array.isArray(body.orderedIds) || body.orderedIds.length === 0) {
    return NextResponse.json({ error: 'orderedIds (non-empty array) is required' }, { status: 400 });
  }

  const categories = getTaskCategoryStore().reorder(body.orderedIds);
  return NextResponse.json({ categories });
}
