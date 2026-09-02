/**
 * Push a hub's projection to the external delivery app (lp-link-hub on Railway).
 *
 * LPOS is the source of truth; on save we POST the hub — its videos (resolved to
 * live Cloudflare Stream UIDs) and its login emails — to the delivery app's
 * /api/ingest, which owns only a read projection.
 *
 * Config (per feedback_doppler_vs_admin_settings):
 *   - LINK_HUB_INGEST_TOKEN  → shared secret, credential → Doppler/env only.
 *   - ingest base URL        → operational knob: admin Settings key
 *                              'link_hubs.ingest_url', with LINK_HUB_INGEST_URL
 *                              env as fallback so it works before a UI exists.
 *
 * Mirrors lib/services/lpai-provisioning.ts (postIngest).
 */
import { getHubDetail } from '@/lib/store/link-hubs-db';
import { getCanonicalMediaAsset } from '@/lib/store/canonical-asset-store';
import { getSetting } from '@/lib/store/lpos-settings-store';
import { getVideoDetails, applyVideoSettings } from '@/lib/services/cloudflare-stream';

export const LINK_HUB_INGEST_URL_SETTING = 'link_hubs.ingest_url';

interface IngestPayload {
  hub: { id: string; name: string; owner_label: string; owner_type: string };
  access_emails: string[];
  items: Array<{
    asset_id: string;
    client_title: string;
    share_token: string;
    asset: { lpos_name: string; cf_stream_uid: string; duration_s: number };
  }>;
}

export interface PushResult {
  pushed: boolean;
  reason?: string;
  videos?: number;
  /** assets left out of the push because they have no Cloudflare Stream UID yet. */
  skipped?: string[];
}

function resolveConfig(): { baseUrl: string; token: string } | null {
  const baseUrl = getSetting<string>(LINK_HUB_INGEST_URL_SETTING, process.env.LINK_HUB_INGEST_URL ?? '').trim();
  const token = (process.env.LINK_HUB_INGEST_TOKEN ?? '').trim();
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/** Build the ingest payload for one hub, resolving each item to a live CF asset. */
export function buildHubPayload(hubId: string): { payload: IngestPayload; skipped: string[] } | null {
  const detail = getHubDetail(hubId);
  if (!detail) return null;

  const items: IngestPayload['items'] = [];
  const skipped: string[] = [];

  for (const item of detail.items) {
    const asset = getCanonicalMediaAsset(item.project_id, item.asset_id);
    const uid = asset?.cloudflare?.uid;
    if (!uid) {
      // The delivery app can only play videos that are on Cloudflare Stream.
      skipped.push(item.client_title || item.asset_id);
      continue;
    }
    items.push({
      asset_id: item.asset_id,
      client_title: item.client_title,
      share_token: item.share_token,
      asset: {
        lpos_name: asset?.name ?? item.asset_id,
        cf_stream_uid: uid,
        duration_s: Math.round(asset?.duration ?? 0),
      },
    });
  }

  return {
    payload: {
      hub: {
        id: detail.hub.id,
        name: detail.hub.name,
        owner_label: detail.hub.owner_label,
        owner_type: detail.hub.owner_type,
      },
      access_emails: detail.access,
      items,
    },
    skipped,
  };
}

/**
 * Origins to ensure on Cloudflare for every video delivered through a hub:
 * `*.leaderpass.com` (covers whatever leaderpass subdomain the app is served
 * from) plus the delivery app's own host (so it also plays on the current URL).
 */
function deliveryOrigins(): string[] {
  const set = new Set<string>(['*.leaderpass.com']);
  const rawUrl = getSetting<string>(LINK_HUB_INGEST_URL_SETTING, process.env.LINK_HUB_INGEST_URL ?? '').trim();
  if (rawUrl) {
    try {
      const host = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).host.toLowerCase();
      if (host) set.add(host);
    } catch {
      /* ignore a malformed url */
    }
  }
  return [...set];
}

/** Merge the delivery origins into a video's CF allowedOrigins. Returns true if it changed. */
async function ensureAllowedOrigins(uid: string): Promise<boolean> {
  const want = deliveryOrigins();
  const current = await getVideoDetails(uid);
  const have = new Set(current.allowedOrigins.map((o) => o.toLowerCase()));
  const missing = want.filter((o) => !have.has(o.toLowerCase()));
  if (missing.length === 0) return false;
  await applyVideoSettings(uid, { allowedOrigins: [...current.allowedOrigins, ...missing] });
  return true;
}

/**
 * When videos are in a hub, make sure each one allows the leaderpass origin on
 * Cloudflare (merged, never clobbering existing origins). Best-effort per video;
 * called on hub save. Never throws.
 */
export async function ensureHubVideoOrigins(hubId: string): Promise<{ updated: number; failed: number }> {
  const built = buildHubPayload(hubId);
  if (!built) return { updated: 0, failed: 0 };
  let updated = 0;
  let failed = 0;
  for (const item of built.payload.items) {
    try {
      if (await ensureAllowedOrigins(item.asset.cf_stream_uid)) updated += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[link-hub] allowedOrigins update failed for ${item.asset.cf_stream_uid}:`, (err as Error).message);
    }
  }
  return { updated, failed };
}

/** POST a hub to the delivery app. Never throws on config gaps — returns a reason. */
export async function pushHubToDelivery(hubId: string): Promise<PushResult> {
  const built = buildHubPayload(hubId);
  if (!built) return { pushed: false, reason: 'hub not found' };

  const config = resolveConfig();
  if (!config) {
    return {
      pushed: false,
      reason: 'delivery app not configured (set LINK_HUB_INGEST_TOKEN and the ingest URL)',
      skipped: built.skipped,
    };
  }

  const res = await fetch(`${config.baseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lpos-token': config.token },
    body: JSON.stringify(built.payload),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    throw new Error(`delivery ingest responded ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  return { pushed: true, videos: built.payload.items.length, skipped: built.skipped };
}
