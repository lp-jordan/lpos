import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import {
  isLpaiConfigured,
  provisionProjectToLpai,
} from '@/lib/services/lpai-provisioning';

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * Manually re-provision every eligible video in a project to LeaderPass AI.
 * Unlike the toggle-ON trigger this awaits the batch and returns a per-video
 * summary so the UI can report success/skip/failure counts. Does not require
 * the toggle to be ON (it's an explicit operator action) but does require
 * LP.AI to be configured.
 */
export async function POST(_req: NextRequest, { params }: Ctx) {
  const { projectId } = await params;

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!isLpaiConfigured()) {
    return NextResponse.json(
      { error: 'LeaderPass AI is not configured on this LPOS host (LPAI_BASE_URL / LPAI_INGEST_SECRET unset).' },
      { status: 501 },
    );
  }

  const { results } = await provisionProjectToLpai(projectId, { trigger: 'reprovision' });

  const pushed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && r.error).length;
  const skipped = results.filter((r) => !r.ok && r.skippedReason).length;

  return NextResponse.json({ ok: true, pushed, failed, skipped, results });
}
