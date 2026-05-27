/**
 * Server-side B2 bucket browser
 *
 * Direct S3 reads/deletes against the cold-storage B2 bucket, gated by the
 * admin role at the route layer. Uses the master Doppler credentials — no
 * scoped-key minting needed, no editpanel.
 */

import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { isB2MediaConfigured } from './b2-media-sync-service';
import { markDeleted } from '@/lib/store/b2-cold-storage-store';

export interface BrowseEntry {
  folders: Array<{ prefix: string; name: string }>;
  files:   Array<{ key: string; name: string; size: number; lastModified: string | null }>;
}

function makeClient(): S3Client {
  return new S3Client({
    region:   'auto',
    endpoint: process.env.B2_MEDIA_ENDPOINT!,
    credentials: {
      accessKeyId:     process.env.B2_MEDIA_KEY_ID!,
      secretAccessKey: process.env.B2_MEDIA_APPLICATION_KEY!,
    },
  });
}

function getBucket(): string {
  return process.env.B2_MEDIA_BUCKET ?? '';
}

/**
 * List one "level" of the bucket via the '/' delimiter. Returns subfolders
 * (CommonPrefixes) and file entries that live directly under `prefix`.
 */
export async function browse(prefix = ''): Promise<BrowseEntry> {
  if (!isB2MediaConfigured()) {
    throw new Error('B2 credentials not configured');
  }
  const client = makeClient();
  const bucket = getBucket();
  const folders: BrowseEntry['folders'] = [];
  const files:   BrowseEntry['files']   = [];
  let token: string | undefined;

  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket:            bucket,
      Prefix:            prefix,
      Delimiter:         '/',
      ContinuationToken: token,
    }));

    for (const cp of res.CommonPrefixes ?? []) {
      if (!cp.Prefix) continue;
      const name = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
      folders.push({ prefix: cp.Prefix, name });
    }
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix) continue;
      files.push({
        key:          obj.Key,
        name:         obj.Key.slice(prefix.length),
        size:         obj.Size ?? 0,
        lastModified: obj.LastModified ? obj.LastModified.toISOString() : null,
      });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return { folders, files };
}

/** Delete a single B2 object and stamp deleted_at on the tracking row. */
export async function deleteOne(key: string): Promise<void> {
  if (!isB2MediaConfigured()) throw new Error('B2 credentials not configured');
  if (!key) throw new Error('key required');
  const client = makeClient();
  await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
  markDeleted(key, new Date().toISOString());
}

/**
 * Delete every object under `prefix`. Returns the count of objects removed.
 * Refuses an empty prefix (would empty the bucket).
 */
export async function deletePrefix(prefix: string): Promise<number> {
  if (!isB2MediaConfigured()) throw new Error('B2 credentials not configured');
  if (!prefix) throw new Error('prefix required (refusing to delete bucket root)');
  const client = makeClient();
  const bucket = getBucket();
  const now    = new Date().toISOString();
  let deleted  = 0;
  let token: string | undefined;

  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket:            bucket,
      Prefix:            prefix,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
      markDeleted(obj.Key, now);
      deleted++;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return deleted;
}
