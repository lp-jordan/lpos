/**
 * GET /api/tasks/[taskId]/review-checkin
 *
 * Returns the pending Review check-in for this task (or null). The task detail
 * modal calls this to decide whether to show the "sitting in Review" prompt +
 * Acknowledge control.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskReviewCheckinStore } from '@/lib/services/container';

type Params = { params: Promise<{ taskId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId } = await params;
  const checkin = getTaskReviewCheckinStore().getPendingForTask(taskId);
  return NextResponse.json({ checkin });
}
