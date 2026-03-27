import { NextRequest, NextResponse } from 'next/server';
import { deleteShare } from '@/lib/services/frameio';

type Params = { params: Promise<{ shareId: string }> };

/**
 * DELETE /api/shares/[shareId]
 *
 * Deletes a Frame.io share that is not tracked in any project's local store
 * (i.e. shares shown in the "Unassigned" group of the global share manager).
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { shareId } = await params;
    await deleteShare(shareId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
