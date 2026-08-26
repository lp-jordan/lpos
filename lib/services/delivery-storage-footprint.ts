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
 * needed. Read-only; can be slow on a bucket with many links, so it runs on
 * explicit admin request rather than on any poll.
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const DELIVERY_PREFIX = 'delivery/';

/** Cap the per-token list returned to the client so the payload stays bounded
 *  even with thousands of live links. Totals below always reflect the full
 *  bucket regardless of this cap. */
const MAX_TOKENS_RETURNED = 100;

export interface DeliveryTokenUsage {
  token:   string;
  bytes:   number;
  objects: number;
}

export interface DeliveryStorageFootprint {
  totalBytes:    number;
  totalObjects:  number;
  tokenCount:    number;              // distinct delivery links with bytes in R2
  tokens:        DeliveryTokenUsage[]; // largest first, capped at MAX_TOKENS_RETURNED
  tokensTruncated: boolean;           // true when tokenCount > tokens.length
  scannedAt:     string;
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
        byToken.set(token, { token, bytes: size, objects: 1 });
      }
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  const ranked = Array.from(byToken.values()).sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes,
    totalObjects,
    tokenCount:      byToken.size,
    tokens:          ranked.slice(0, MAX_TOKENS_RETURNED),
    tokensTruncated: ranked.length > MAX_TOKENS_RETURNED,
    scannedAt:       new Date().toISOString(),
  };
}
