import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import { resolveRequestActor } from '@/lib/services/activity-actor';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import {
  isLpaiConfigured,
  isProjectLpaiEnabled,
  setProjectLpaiEnabled,
  triggerProjectProvisioning,
} from '@/lib/services/lpai-provisioning';

type Ctx = { params: Promise<{ projectId: string }> };

/** Read the current "Use in LeaderPass AI" toggle state for a project. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId } = await params;
  return NextResponse.json({
    enabled: isProjectLpaiEnabled(projectId),
    configured: isLpaiConfigured(),
  });
}

/** Set the toggle. On toggle-ON, provisions all current videos in the project. */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { projectId } = await params;
  const body = await req.json() as { enabled?: boolean };
  const enabled = body.enabled === true;

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const previous = isProjectLpaiEnabled(projectId);
  setProjectLpaiEnabled(projectId, enabled);

  recordActivity({
    ...resolveRequestActor(req),
    occurred_at: new Date().toISOString(),
    event_type: enabled ? 'lpai.project.enabled' : 'lpai.project.disabled',
    lifecycle_phase: 'updated',
    source_kind: 'api',
    visibility: 'user_timeline',
    title: `LeaderPass AI ${enabled ? 'enabled' : 'disabled'}: ${project.name}`,
    summary: enabled
      ? `${project.name} videos will be provisioned to LeaderPass AI`
      : `${project.name} will no longer push new videos to LeaderPass AI`,
    client_id: project.clientName || null,
    project_id: projectId,
    source_service: 'lpai-provisioning',
    details_json: { enabled, previous },
  });

  // On toggle-ON, provision all current videos (fire-and-forget). Toggle-OFF
  // just stops future pushes; removal from LP.AI is a later concern.
  let provisioning = false;
  if (enabled && !previous) {
    if (isLpaiConfigured()) {
      triggerProjectProvisioning(projectId, { trigger: 'toggle_on' });
      provisioning = true;
    }
  }

  return NextResponse.json({
    enabled,
    configured: isLpaiConfigured(),
    provisioning,
  });
}
