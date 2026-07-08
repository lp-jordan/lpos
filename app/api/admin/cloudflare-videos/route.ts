/**
 * GET /api/admin/cloudflare-videos — list every video in the Cloudflare Stream account,
 * enriched with LPOS context (which asset/project each UID maps to, and whether LPOS
 * still considers it live) plus aggregate totals for the 3000-minute storage budget.
 *
 * Admin-only. This is the read side of the Cloudflare Library admin panel. It calls
 * Cloudflare's list API directly (not a hot path — the panel loads it on demand) and
 * cross-references distribution_records so an admin can see, sort, and manage the whole
 * library from LPOS instead of Cloudflare's own dashboard.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import {
  isCloudflareStreamConfigured,
  listCloudflareVideos,
  type CloudflareVideoSummary,
} from '@/lib/services/cloudflare-stream';
import { getLiveCloudflareUids, resolveAssetByCloudflareUid } from '@/lib/store/canonical-asset-store';
import { getCoreDb } from '@/lib/store/core-db';

interface EnrichedVideo {
  uid: string;
  status: string;
  created: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  thumbnail: string | null;
  /** True when LPOS still considers this UID the live Cloudflare publication of an active asset. */
  isLive: boolean;
  /** True when a distribution_record ties this UID to an LPOS asset (active or archived). */
  isTracked: boolean;
  assetId: string | null;
  projectId: string | null;
  assetName: string | null;
  projectName: string | null;
  clientName: string | null;
}

function metaName(video: CloudflareVideoSummary): string | null {
  return typeof video.meta?.name === 'string' ? (video.meta.name as string) : null;
}

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  if (!isCloudflareStreamConfigured()) {
    return NextResponse.json({ configured: false, videos: [], totals: null });
  }

  let videos: CloudflareVideoSummary[];
  try {
    videos = await listCloudflareVideos();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const live = getLiveCloudflareUids();

  // Resolve LPOS asset context per UID, collecting project IDs for a single batched lookup.
  const resolved = videos.map((v) => ({ video: v, asset: resolveAssetByCloudflareUid(v.uid) }));
  const projectIds = [...new Set(resolved.map((r) => r.asset?.projectId).filter((p): p is string => !!p))];

  const projectById = new Map<string, { name: string; client_name: string }>();
  if (projectIds.length > 0) {
    const placeholders = projectIds.map(() => '?').join(',');
    const rows = getCoreDb()
      .prepare(`SELECT project_id, name, client_name FROM projects WHERE project_id IN (${placeholders})`)
      .all(...projectIds) as Array<{ project_id: string; name: string; client_name: string }>;
    for (const r of rows) projectById.set(r.project_id, { name: r.name, client_name: r.client_name });
  }

  const enriched: EnrichedVideo[] = resolved.map(({ video, asset }) => {
    const proj = asset?.projectId ? projectById.get(asset.projectId) : undefined;
    return {
      uid: video.uid,
      status: video.status,
      created: video.created,
      durationSeconds: video.duration,
      sizeBytes: video.size,
      thumbnail: video.thumbnail,
      isLive: live.has(video.uid),
      isTracked: !!asset,
      assetId: asset?.assetId ?? video.creator ?? null,
      projectId: asset?.projectId ?? null,
      assetName: asset?.displayName ?? metaName(video),
      projectName: proj?.name ?? null,
      clientName: proj?.client_name ?? null,
    };
  });

  const totals = {
    count: enriched.length,
    totalDurationSeconds: enriched.reduce((sum, v) => sum + (v.durationSeconds ?? 0), 0),
    totalSizeBytes: enriched.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0),
    liveCount: enriched.filter((v) => v.isLive).length,
    untrackedCount: enriched.filter((v) => !v.isTracked).length,
  };

  return NextResponse.json({ configured: true, videos: enriched, totals });
}
