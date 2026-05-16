/**
 * PATCH  /api/task-categories/[categoryId]   — rename (admin only). Cascades label
 *                                              change to every task currently tagged
 *                                              with the old label.
 * DELETE /api/task-categories/[categoryId]   — delete (admin only). Blocked with
 *                                              HTTP 409 if any task still uses it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getTaskCategoryStore } from '@/lib/services/container';
import { TaskCategoryError } from '@/lib/store/task-category-store';

type Ctx = { params: Promise<{ categoryId: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const { categoryId } = await params;
  const body = await req.json().catch(() => ({})) as { label?: string };
  if (!body.label?.trim()) {
    return NextResponse.json({ error: 'label is required' }, { status: 400 });
  }

  try {
    const updated = getTaskCategoryStore().rename(categoryId, body.label);
    return NextResponse.json({ category: updated });
  } catch (err) {
    if (err instanceof TaskCategoryError) {
      const status = err.code === 'duplicate' ? 409 : err.code === 'not_found' ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const { categoryId } = await params;
  try {
    getTaskCategoryStore().remove(categoryId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TaskCategoryError) {
      const status = err.code === 'in_use' ? 409 : err.code === 'not_found' ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
