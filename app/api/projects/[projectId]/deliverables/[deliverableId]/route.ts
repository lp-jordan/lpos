/**
 * Phase E: Single deliverable API.
 *
 * GET    — fetch one deliverable with its asset rows
 * PATCH  — update name / expiresAt / settings (NOT assets — use the assets sub-route)
 * DELETE — delete the deliverable AND the Frame.io share it backs
 *
 * Frame.io share deletion is best-effort: if it fails (already deleted on
 * Frame.io's side, network blip, etc.) we still remove our local row so the
 * user isn't blocked. An orphan Frame.io share that we no longer track is a
 * cleanup job's problem, not the user's.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import {
  getDeliverable,
  getDeliverableAssets,
  updateDeliverable,
  deleteDeliverable,
} from '@/lib/store/deliverable-store';
import { deleteShare, updateShareSettings } from '@/lib/services/frameio';
import type { DeliverableSettings } from '@/lib/models/deliverable';

type Params = { params: Promise<{ projectId: string; deliverableId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { deliverableId } = await params;
  const deliverable = getDeliverable(deliverableId);
  if (!deliverable) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const assets = getDeliverableAssets(deliverableId);
  return NextResponse.json({ deliverable, assets });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { deliverableId } = await params;
  const body = await req.json().catch(() => ({})) as {
    name?: string;
    expiresAt?: string | null;
    settings?: DeliverableSettings;
  };

  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
  }

  const existing = getDeliverable(deliverableId);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Push name + downloads (+ expiration) to Frame.io so the share's name in
  // Frame.io matches what clients receiving the link see. Only forward fields
  // the caller actually changed so we don't reset unrelated Frame.io state.
  // Best-effort: if Frame.io rejects, we surface the error but still leave
  // the API contract clean — the local update only happens after the Frame.io
  // call succeeds so the two stay in sync.
  const frameioPatch: {
    name?: string;
    downloading_enabled?: boolean;
    expiration?: string | null;
  } = {};
  if (body.name !== undefined && body.name.trim() !== existing.name) {
    frameioPatch.name = body.name.trim();
  }
  if (
    body.settings?.downloading_enabled !== undefined &&
    body.settings.downloading_enabled !== existing.settings.downloading_enabled
  ) {
    frameioPatch.downloading_enabled = body.settings.downloading_enabled;
  }
  if (body.expiresAt !== undefined && body.expiresAt !== existing.expiresAt) {
    frameioPatch.expiration = body.expiresAt;
  }

  if (Object.keys(frameioPatch).length > 0) {
    try {
      await updateShareSettings(existing.frameioShareId, frameioPatch);
    } catch (err) {
      return NextResponse.json(
        { error: `Frame.io rejected the update: ${(err as Error).message}` },
        { status: 502 },
      );
    }
  }

  const updated = updateDeliverable(deliverableId, {
    name: body.name?.trim(),
    expiresAt: body.expiresAt,
    settings: body.settings,
  });
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ deliverable: updated });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const { deliverableId } = await params;
  const deliverable = getDeliverable(deliverableId);
  if (!deliverable) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    await deleteShare(deliverable.frameioShareId);
  } catch (err) {
    console.warn(
      `[deliverables DELETE] Frame.io share ${deliverable.frameioShareId} delete failed (continuing): ${(err as Error).message}`,
    );
  }

  deleteDeliverable(deliverableId);
  return NextResponse.json({ ok: true });
}
