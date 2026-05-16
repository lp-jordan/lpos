/**
 * CloudflareOrphanReconciler
 *
 * Periodic, report-only sweep that lists all videos in the Cloudflare Stream account
 * and compares them against the set of UIDs LPOS considers "live" (the latest
 * Cloudflare publication per active asset). Anything at Cloudflare that LPOS does NOT
 * consider live is recorded in the `cloudflare_orphans` table for manual purge.
 *
 * Crucially: this service NEVER deletes anything at Cloudflare on its own. The user
 * explicitly asked for an airtight workflow — no surprise deletes a week later.
 * Detection is automatic; purge is always a deliberate human action via the admin UI.
 *
 * Schedule:
 *  - Runs ~5 minutes after start() (lets the rest of initServices finish)
 *  - Repeats every 24 h thereafter
 */

import { isCloudflareStreamConfigured, listCloudflareVideos, type CloudflareVideoSummary } from '@/lib/services/cloudflare-stream';
import { getLiveCloudflareUids, resolveAssetByCloudflareUid } from '@/lib/store/canonical-asset-store';
import { listActiveOrphans, recordOrphan, refreshOrphanContext } from '@/lib/store/cloudflare-orphan-store';

/**
 * Resolve human-readable context (asset name, asset_id, project_id) for an orphan UID.
 * DB-first because our distribution_records are the source of truth: if the asset still
 * exists (active or archived), we get exact info. Falls back to the CF video's own metadata
 * — `meta.name` and the `creator` field — which we set at upload time and which survives
 * even after the asset is hard-deleted from our DB.
 */
function resolveOrphanContext(video: CloudflareVideoSummary): {
  assetId: string | null;
  projectId: string | null;
  name: string | null;
} {
  const fromDb = resolveAssetByCloudflareUid(video.uid);
  if (fromDb) {
    return { assetId: fromDb.assetId, projectId: fromDb.projectId, name: fromDb.displayName };
  }
  const metaName = typeof video.meta?.name === 'string' ? (video.meta.name as string) : null;
  return { assetId: video.creator, projectId: null, name: metaName };
}

const FIRST_RUN_DELAY_MS = 5 * 60_000;
const INTERVAL_MS = 24 * 60 * 60_000;

export interface ReconcileSummary {
  ok: boolean;
  reason?: string;
  cloudflareCount: number;
  liveCount: number;
  candidateOrphans: number;
  newlyRecorded: number;
  refreshedExisting: number;
}

export class CloudflareOrphanReconciler {
  private firstRunTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;
    this.firstRunTimer = setTimeout(() => { void this.runOnce(); }, FIRST_RUN_DELAY_MS);
    this.timer = setInterval(() => { void this.runOnce(); }, INTERVAL_MS);
  }

  stop(): void {
    if (this.firstRunTimer) { clearTimeout(this.firstRunTimer); this.firstRunTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async runOnce(): Promise<ReconcileSummary> {
    if (!isCloudflareStreamConfigured()) {
      const summary: ReconcileSummary = {
        ok: false,
        reason: 'Cloudflare Stream is not configured on this host.',
        cloudflareCount: 0,
        liveCount: 0,
        candidateOrphans: 0,
        newlyRecorded: 0,
        refreshedExisting: 0,
      };
      console.log('[cf-orphan-reconciler] skipped — Cloudflare not configured');
      return summary;
    }

    console.log('[cf-orphan-reconciler] starting reconciliation pass');
    try {
      const cfVideos = await listCloudflareVideos();
      const live = getLiveCloudflareUids();
      const knownOrphans = new Set(listActiveOrphans().map((o) => o.uid));

      const orphanVideos: CloudflareVideoSummary[] = [];
      const newVideos: CloudflareVideoSummary[] = [];
      const refreshVideos: CloudflareVideoSummary[] = [];

      for (const v of cfVideos) {
        if (live.has(v.uid)) continue;
        orphanVideos.push(v);
        if (knownOrphans.has(v.uid)) refreshVideos.push(v);
        else newVideos.push(v);
      }

      for (const v of newVideos) {
        const ctx = resolveOrphanContext(v);
        recordOrphan({
          uid: v.uid,
          reason: 'reconciler',
          assetId: ctx.assetId,
          projectId: ctx.projectId,
          name: ctx.name,
          attempts: 0,
          lastError: null,
        });
      }
      for (const v of refreshVideos) {
        refreshOrphanContext(v.uid, resolveOrphanContext(v));
      }

      const summary: ReconcileSummary = {
        ok: true,
        cloudflareCount: cfVideos.length,
        liveCount: live.size,
        candidateOrphans: orphanVideos.length,
        newlyRecorded: newVideos.length,
        refreshedExisting: refreshVideos.length,
      };
      console.log(`[cf-orphan-reconciler] done — cf=${summary.cloudflareCount} live=${summary.liveCount} orphans=${summary.candidateOrphans} (new=${summary.newlyRecorded}, refreshed=${summary.refreshedExisting})`);
      return summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[cf-orphan-reconciler] failed:', message);
      return {
        ok: false,
        reason: message,
        cloudflareCount: 0,
        liveCount: 0,
        candidateOrphans: 0,
        newlyRecorded: 0,
        refreshedExisting: 0,
      };
    }
  }
}
