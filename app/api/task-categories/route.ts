/**
 * GET  /api/task-categories       — list (any authenticated user, used by New Task modal)
 * POST /api/task-categories       — create (admin only)
 *
 * Read access is open to any signed-in user so the New Task modal can populate
 * its Category dropdown without admin permissions. Mutations stay locked down.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getTaskCategoryStore } from '@/lib/services/container';
import { TaskCategoryError } from '@/lib/store/task-category-store';

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  return NextResponse.json({ categories: getTaskCategoryStore().getAll() });
}

export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const body = await req.json().catch(() => ({})) as { label?: string };
  if (!body.label?.trim()) {
    return NextResponse.json({ error: 'label is required' }, { status: 400 });
  }

  try {
    const category = getTaskCategoryStore().create(body.label);
    return NextResponse.json({ category }, { status: 201 });
  } catch (err) {
    if (err instanceof TaskCategoryError) {
      const status = err.code === 'duplicate' ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
