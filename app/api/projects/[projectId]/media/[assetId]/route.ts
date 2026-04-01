import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { getAsset, patchAsset, removeAsset } from '@/lib/store/media-registry';
import type { AssetPatch } from '@/lib/store/media-registry';
import { getAllShareAssets, removeShareAsset } from '@/lib/store/share-assets-store';
import { resolveRequestActor } from '@/lib/services/activity-actor';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import { deleteFrameioFile } from '@/lib/services/frameio';
import { getTranscripterService } from '@/lib/services/container';

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { projectId, assetId } = await params;
  const asset = getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ asset });
}

// ── PATCH — update editable fields ───────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, assetId } = await params;
    const body = await req.json() as AssetPatch;

    const updated = patchAsset(projectId, assetId, body);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const actor = resolveRequestActor(req);
    const eventType = body.transcription || body.frameio || body.cloudflare || body.leaderpass
      ? 'asset.status.changed'
      : 'asset.metadata.updated';
    recordActivity({
      ...actor,
      occurred_at: new Date().toISOString(),
      event_type: eventType,
      lifecycle_phase: 'updated',
      source_kind: 'api',
      visibility: 'user_timeline',
      title: `Asset updated: ${updated.name || updated.originalFilename}`,
      summary: `${updated.name || updated.originalFilename} was updated`,
      project_id: projectId,
      asset_id: assetId,
      client_id: null,
      details_json: {
        patch: body,
      },
      search_text: `${updated.name || updated.originalFilename} ${updated.originalFilename}`.trim(),
    });
    return NextResponse.json({ asset: updated });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId, assetId } = await params;
    const { searchParams }       = new URL(req.url);
    const deleteFile             = searchParams.get('deleteFile') === 'true';

    const asset = getAsset(projectId, assetId);
    if (!asset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // ── Frame.io deletion ──────────────────────────────────────────────────
    const fioFileId = asset.frameio?.assetId;
    if (fioFileId) {
      // Best-effort: don't let a Frame.io error block local cleanup
      try { await deleteFrameioFile(fioFileId); } catch { /* log silently */ }

      // Remove from any share membership records we track locally.
      // Frame.io handles its own share membership server-side on file deletion,
      // but we still need to keep our local mirror in sync.
      const shareData = getAllShareAssets(projectId);
      for (const [shareId, fileIds] of Object.entries(shareData)) {
        if (fileIds.includes(fioFileId)) {
          removeShareAsset(projectId, shareId, fioFileId);
        }
      }
    }

    // ── Cancel any in-progress transcription for this asset ───────────────
    getTranscripterService().cancelByAsset(assetId);

    // ── Local registry + optional disk file ───────────────────────────────
    const removed = removeAsset(projectId, assetId);
    if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    recordActivity({
      ...resolveRequestActor(req),
      occurred_at: new Date().toISOString(),
      event_type: 'asset.deleted',
      lifecycle_phase: 'superseded',
      source_kind: 'api',
      visibility: 'operator_only',
      title: `Asset deleted: ${removed.name || removed.originalFilename}`,
      summary: `${removed.name || removed.originalFilename} was removed from the project`,
      project_id: projectId,
      asset_id: assetId,
      details_json: {
        deleteFile,
        filePath: removed.filePath,
      },
      search_text: `${removed.name || removed.originalFilename} ${removed.originalFilename}`.trim(),
    });

    if (deleteFile && removed.storageType === 'uploaded' && removed.filePath) {
      try { if (fs.existsSync(removed.filePath)) fs.unlinkSync(removed.filePath); } catch { /* ignore */ }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
