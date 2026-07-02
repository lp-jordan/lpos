import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import { requireRole } from '@/lib/services/api-auth';
import {
  isLpaiConfigured,
  triggerProjectProvisioning,
} from '@/lib/services/lpai-provisioning';

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * Manually re-provision every eligible video in a project to LeaderPass AI.
 *
 * This is now a BACKGROUND "transcribe-then-push" batch, not an instant op: each
 * video first gets a high-quality large-v3-turbo word-level transcript (produced
 * once, then cached) before its LP.AI push. Because that can take many minutes on
 * long videos, we kick the batch off fire-and-forget and return 202 immediately —
 * blocking the request thread on the whole set would time out. Per-video
 * push/skip/fail land on the activity timeline (`lpai.ingest.*`).
 *
 * Does not require the toggle to be ON (explicit operator action) but does require
 * LP.AI to be configured. Admin-only.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const { projectId } = await params;

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!isLpaiConfigured()) {
    return NextResponse.json(
      { error: 'LeaderPass AI is not configured on this LPOS host (LPAI_BASE_URL / LPAI_PROVISIONING_SECRET unset).' },
      { status: 501 },
    );
  }

  triggerProjectProvisioning(projectId, { trigger: 'reprovision' });

  return NextResponse.json(
    {
      ok: true,
      accepted: true,
      message: 'Re-provisioning started in the background — each video is transcribed at turbo quality, then pushed. Watch the activity timeline for progress.',
    },
    { status: 202 },
  );
}
