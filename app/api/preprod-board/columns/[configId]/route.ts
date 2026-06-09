import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requirePreprodBoardAdmin } from '@/lib/services/api-auth';
import {
  countTasksInPhaseSlug,
  deletePhaseConfig,
  getPhaseConfigById,
  getPhaseConfigsForType,
  updatePhaseConfig,
} from '@/lib/store/task-phase-config-store';

/**
 * PATCH — rename / recolor an existing column. Slug is intentionally immutable
 * (it's referenced by tasks.status).
 * DELETE — remove a column. Refuses if any tasks still live in it; the column
 * editor surfaces that count and asks the user to move them first.
 */

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ configId: string }> },
) {
  const deny = await requirePreprodBoardAdmin(req);
  if (deny) return deny;

  const { configId } = await params;
  const body = (await req.json()) as { label?: unknown; color?: unknown };

  const patch: { label?: string; color?: string } = {};
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || !body.label.trim()) {
      return NextResponse.json({ error: 'label must be a non-empty string.' }, { status: 400 });
    }
    patch.label = body.label;
  }
  if (body.color !== undefined) {
    if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
      return NextResponse.json({ error: 'color must be a hex string like #aabbcc.' }, { status: 400 });
    }
    patch.color = body.color;
  }

  const updated = updatePhaseConfig(configId, patch);
  if (!updated) return NextResponse.json({ error: 'Column not found.' }, { status: 404 });

  return NextResponse.json({ column: updated, columns: getPhaseConfigsForType('preprod') });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ configId: string }> },
) {
  const deny = await requirePreprodBoardAdmin(req);
  if (deny) return deny;

  const { configId } = await params;
  const existing = getPhaseConfigById(configId);
  if (!existing) return NextResponse.json({ error: 'Column not found.' }, { status: 404 });

  const taskCount = countTasksInPhaseSlug(existing.taskType, existing.slug);
  if (taskCount > 0) {
    return NextResponse.json(
      {
        error: `Column has ${taskCount} task${taskCount === 1 ? '' : 's'}. Move them first.`,
        taskCount,
      },
      { status: 409 },
    );
  }

  deletePhaseConfig(configId);
  return NextResponse.json({ columns: getPhaseConfigsForType(existing.taskType) });
}
