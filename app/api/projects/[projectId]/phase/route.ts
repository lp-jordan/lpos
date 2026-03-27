import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getProjectStore } from '@/lib/services/container';
import { SUBPHASE_PHASE_MAP } from '@/lib/models/project';
import type { ProjectPhase, ProjectSubPhase } from '@/lib/models/project';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId } = await params;
  const body = await req.json() as { phase?: ProjectPhase; subPhase?: ProjectSubPhase };
  const { phase, subPhase } = body;

  if (!phase || !subPhase) {
    return NextResponse.json({ error: 'phase and subPhase are required' }, { status: 400 });
  }
  if (SUBPHASE_PHASE_MAP[subPhase] !== phase) {
    return NextResponse.json({ error: 'subPhase does not belong to that phase' }, { status: 400 });
  }

  const store = getProjectStore();
  const updated = store.update(projectId, { phase, subPhase }, { source_kind: 'ui' });
  if (!updated) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  return NextResponse.json({ project: updated });
}
