import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { startApproveAll } from '@/lib/services/cold-storage-approve-all';

/**
 * POST /api/admin/cold-storage/approve-all
 *
 * Kick off a bulk approve-delete of every object currently awaiting review
 * (those whose missing_since has aged past retainDays). The delete loop is
 * serial and can take minutes on a large list, so it runs in the BACKGROUND —
 * this route returns immediately with the initial progress, and the client
 * polls the cold-storage overview endpoint (which carries `approveAll`) to show
 * "Purging N of M" and refresh the list as it drains.
 *
 * Guarded: if a run is already in progress, this is a no-op — `started` comes
 * back false with the live progress, so a double-click or a second admin can't
 * spawn an overlapping loop over the same queue.
 */
export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const { started, progress } = startApproveAll();
  return NextResponse.json({ started, progress });
}
