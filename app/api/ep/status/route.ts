import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { upsertInstance } from '@/lib/store/ep-instances';

/**
 * POST /api/ep/status
 *
 * Receives a heartbeat from an EditPanel instance every ~10 seconds.
 * Stores current Resolve state, job queue counts, and instance identity.
 */
export async function POST(req: NextRequest) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json() as {
    instance_id?: string;
    display_name?: string;
    resolve_connected?: boolean;
    resolve_project?: string | null;
    resolve_timeline?: string | null;
    jobs_queued?: number;
    jobs_running?: number;
  };

  if (!body.instance_id) {
    return NextResponse.json({ error: 'instance_id is required' }, { status: 400 });
  }

  const instance = upsertInstance({
    instanceId: body.instance_id,
    displayName: body.display_name ?? body.instance_id,
    resolveConnected: body.resolve_connected ?? false,
    resolveProject: body.resolve_project ?? null,
    resolveTimeline: body.resolve_timeline ?? null,
    jobsQueued: body.jobs_queued ?? 0,
    jobsRunning: body.jobs_running ?? 0,
  });

  return NextResponse.json({ ok: true, instance });
}
