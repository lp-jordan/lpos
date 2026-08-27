/**
 * Live delivery-link storage footprint (Cloudflare R2)
 *
 * Delivery links freeze a copy of each asset's bytes into the R2 bucket under
 * `delivery/{token}/...` (see delivery-upload.ts). Unlike the B2 cold-storage
 * bucket, LPOS keeps no local tally of these objects — the link records live on
 * the external lpos-ingest server, and the bytes only exist in R2. So the only
 * way to answer "how much are our delivery links costing in storage?" is to ask
 * R2 directly.
 *
 * This walks every object under the `delivery/` prefix via ListObjectsV2 and
 * tallies total bytes/objects plus a per-token breakdown (one token == one
 * delivery link). R2 is not versioned the way the cold-storage B2 bucket is, so
 * a single current-object walk is the true footprint — no ListObjectVersions
 * needed.
 *
 * Two enrichments on top of the raw walk:
 *   • Estimated monthly cost — R2 bills storage at a flat per-GB-month rate;
 *     egress is free, so storage is the whole bill for this bucket.
 *   • Owning project per token — the R2 key only carries the opaque token, so we
 *     best-effort call the ingest server's link list (token → project/client/
 *     label) and join it, plus a per-project rollup. If ingest is unreachable
 *     the footprint still returns, just without the project annotations.
 *
 * Read-only; can be slow on a bucket with many links, so it runs on explicit
 * admin request rather than on any poll.
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getProjectStore } from '@/lib/services/container';

const DELIVERY_PREFIX = 'delivery/';

/** Cap the per-token list returned to the client so the payload stays bounded
 *  even with thousands of live links. Totals and the per-project rollup below
 *  always reflect the FULL bucket regardless of this cap. */
const MAX_TOKENS_RETURNED = 100;

/** Cloudflare R2 standard storage price. Egress/Class-B are free on R2, so for a
 *  storage-only bucket this rate is the entire monthly bill. Cloudflare bills a
 *  "GB-month" as 1e9 bytes (decimal GB). Update here if the plan rate changes. */
const R2_STORAGE_USD_PER_GB_MONTH = 0.015;

const BYTES_PER_BILLING_GB = 1_000_000_000;

/** Estimated monthly R2 storage cost for a given byte count (USD). */
export function estMonthlyCostUsd(bytes: number): number {
  return (bytes / BYTES_PER_BILLING_GB) * R2_STORAGE_USD_PER_GB_MONTH;
}

export interface DeliveryTokenUsage {
  token:        string;
  bytes:        number;
  objects:      number;
  costUsd:      number;             // estimated monthly R2 cost for this link
  projectName?: string | null;      // from ingest link list (null if unmatched)
  clientName?:  string | null;
  label?:       string | null;
  projectId?:   string | null;      // resolved locally from project name (best effort)
}

export interface DeliveryProjectUsage {
  projectName: string;              // "(unknown / revoked)" for unmatched tokens
  clientName:  string | null;
  projectId:   string | null;
  bytes:       number;
  objects:     number;
  linkCount:   number;
  costUsd:     number;
}

export interface DeliveryStorageFootprint {
  totalBytes:      number;
  totalObjects:    number;
  tokenCount:      number;              // distinct delivery links with bytes in R2
  tokens:          DeliveryTokenUsage[]; // largest first, capped at MAX_TOKENS_RETURNED
  tokensTruncated: boolean;             // true when tokenCount > tokens.length
  projects:        DeliveryProjectUsage[]; // per-project rollup over the FULL bucket
  costUsd:         number;              // estimated total monthly R2 storage cost
  costRateUsdPerGbMonth: number;        // the rate used, so the UI can show it
  enriched:        boolean;             // false when the ingest link list was unreachable
  unmatchedTokens: number;              // R2 tokens with no live ingest link (revoked/orphaned)
  unmatchedBytes:  number;
  scannedAt:       string;
}

export function isDeliveryStorageConfigured(): boolean {
  return Boolean(
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
  );
}

function makeClient(): S3Client {
  return new S3Client({
    region:   'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

/** Pull the delivery token out of a key like `delivery/<token>/<file>`.
 *  Returns null for anything that isn't a real per-token object. */
function tokenOf(key: string): string | null {
  if (!key.startsWith(DELIVERY_PREFIX)) return null;
  const rest = key.slice(DELIVERY_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null; // no token segment, or a bare `delivery/<token>` marker
  return rest.slice(0, slash);
}

interface IngestLink {
  token:        string;
  project_name: string | null;
  client_name:  string | null;
  label:        string | null;
}

/** Best-effort fetch of the ingest server's full live-link list, keyed by token.
 *  Returns null (not throw) on any failure so the footprint still renders. */
async function fetchIngestLinkMap(): Promise<Map<string, IngestLink> | null> {
  const base = (process.env.INGEST_BASE_URL ?? '').replace(/\/$/, '');
  const key  = process.env.INGEST_API_KEY;
  if (!base || !key) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${base}/api/delivery`, {
      headers: { 'x-api-key': key },
      signal:  ctrl.signal,
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as IngestLink[];
    if (!Array.isArray(rows)) return null;
    const map = new Map<string, IngestLink>();
    for (const r of rows) {
      if (r && typeof r.token === 'string') map.set(r.token, r);
    }
    return map;
  } catch {
    return null; // ingest down / timeout / bad payload — degrade gracefully
  } finally {
    clearTimeout(timer);
  }
}

/** Build an unambiguous project-name → {id, clientName} map from the local
 *  project store. Names shared by 2+ projects are dropped (ambiguous → no id). */
function buildProjectNameIndex(): Map<string, { projectId: string; clientName: string | null }> {
  const index = new Map<string, { projectId: string; clientName: string | null } | null>();
  try {
    for (const p of getProjectStore().getAll()) {
      if (!p?.name) continue;
      index.set(p.name, index.has(p.name)
        ? null // seen before → ambiguous
        : { projectId: p.projectId, clientName: p.clientName ?? null });
    }
  } catch {
    // store unavailable — leave the index empty; tokens keep their ingest name only
  }
  const clean = new Map<string, { projectId: string; clientName: string | null }>();
  for (const [name, v] of index) if (v) clean.set(name, v);
  return clean;
}

const UNKNOWN_PROJECT = '(unknown / revoked)';

export async function getDeliveryStorageFootprint(): Promise<DeliveryStorageFootprint> {
  if (!isDeliveryStorageConfigured()) {
    throw new Error('R2 delivery storage credentials not configured');
  }
  const client = makeClient();
  const bucket = process.env.R2_BUCKET!;

  let totalBytes = 0;
  let totalObjects = 0;
  const byToken = new Map<string, DeliveryTokenUsage>();

  let continuationToken: string | undefined;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket:            bucket,
      Prefix:            DELIVERY_PREFIX,
      ContinuationToken: continuationToken,
    }));

    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      const size = obj.Size ?? 0;
      totalBytes += size;
      totalObjects += 1;

      const token = tokenOf(obj.Key);
      if (!token) continue;
      const entry = byToken.get(token);
      if (entry) {
        entry.bytes += size;
        entry.objects += 1;
      } else {
        byToken.set(token, { token, bytes: size, objects: 1, costUsd: 0 });
      }
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  // Enrich with owning project (best effort) + per-token cost.
  const ingest = await fetchIngestLinkMap();
  const nameIndex = ingest ? buildProjectNameIndex() : new Map();

  let unmatchedTokens = 0;
  let unmatchedBytes = 0;
  const projectAgg = new Map<string, DeliveryProjectUsage>();

  for (const t of byToken.values()) {
    t.costUsd = estMonthlyCostUsd(t.bytes);

    const link = ingest?.get(t.token);
    if (link) {
      t.projectName = link.project_name ?? null;
      t.clientName  = link.client_name ?? null;
      t.label       = link.label ?? null;
      const resolved = link.project_name ? nameIndex.get(link.project_name) : undefined;
      t.projectId   = resolved?.projectId ?? null;
      if (!t.clientName && resolved?.clientName) t.clientName = resolved.clientName;
    } else if (ingest) {
      // ingest was reachable but this token isn't a live link → revoked/orphaned
      unmatchedTokens += 1;
      unmatchedBytes  += t.bytes;
    }

    // per-project rollup (only meaningful when enriched)
    if (ingest) {
      const pname = t.projectName || UNKNOWN_PROJECT;
      const agg = projectAgg.get(pname);
      if (agg) {
        agg.bytes += t.bytes; agg.objects += t.objects; agg.linkCount += 1; agg.costUsd += t.costUsd;
      } else {
        projectAgg.set(pname, {
          projectName: pname,
          clientName:  t.clientName ?? null,
          projectId:   t.projectId ?? null,
          bytes:       t.bytes,
          objects:     t.objects,
          linkCount:   1,
          costUsd:     t.costUsd,
        });
      }
    }
  }

  const ranked = Array.from(byToken.values()).sort((a, b) => b.bytes - a.bytes);
  const projects = Array.from(projectAgg.values()).sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes,
    totalObjects,
    tokenCount:      byToken.size,
    tokens:          ranked.slice(0, MAX_TOKENS_RETURNED),
    tokensTruncated: ranked.length > MAX_TOKENS_RETURNED,
    projects,
    costUsd:         estMonthlyCostUsd(totalBytes),
    costRateUsdPerGbMonth: R2_STORAGE_USD_PER_GB_MONTH,
    enriched:        ingest !== null,
    unmatchedTokens,
    unmatchedBytes,
    scannedAt:       new Date().toISOString(),
  };
}
