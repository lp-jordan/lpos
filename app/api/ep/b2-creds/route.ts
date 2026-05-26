import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';

/**
 * POST /api/ep/b2-creds
 *
 * Mints a short-lived, bucket-scoped Backblaze B2 application key for the
 * caller's editpanel instance. The B2 master key never leaves this server.
 *
 * Body: ignored (kept POST so we can extend it later with capability flags).
 *
 * Response:
 *   {
 *     ok: true,
 *     data: {
 *       keyId,           // applicationKeyId — use as S3 accessKeyId
 *       applicationKey,  // raw applicationKey — use as S3 secretAccessKey
 *       endpoint,        // mirrors B2_MEDIA_ENDPOINT
 *       bucket,          // mirrors B2_MEDIA_BUCKET
 *       expiresAt        // ISO 8601 — refresh before this time
 *     }
 *   }
 *
 * Backblaze native API calls used (the keys minted here are usable against
 * both the native and S3-compatible endpoints — editpanel uses S3):
 *   POST https://api.backblazeb2.com/b2api/v2/b2_authorize_account
 *   POST <apiUrl>/b2api/v2/b2_list_buckets        — resolve bucket name → bucketId
 *   POST <apiUrl>/b2api/v2/b2_create_key          — mint scoped key
 */

const B2_AUTHORIZE_URL = 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account';
const KEY_TTL_SECONDS  = 3600;

type AuthorizeResponse = {
  accountId:          string;
  authorizationToken: string;
  apiUrl:             string;
};

type Bucket = { bucketId: string; bucketName: string };
type ListBucketsResponse = { buckets: Bucket[] };

type CreateKeyResponse = {
  keyName:           string;
  applicationKeyId:  string;
  applicationKey:    string;
  bucketId:          string;
  capabilities:      string[];
  expirationTimestamp: number | null;
};

async function b2Authorize(keyId: string, applicationKey: string): Promise<AuthorizeResponse> {
  const credentials = Buffer.from(`${keyId}:${applicationKey}`).toString('base64');
  const res = await fetch(B2_AUTHORIZE_URL, {
    headers: { Authorization: `Basic ${credentials}` },
    cache:   'no-store',
  });
  if (!res.ok) throw new Error(`b2_authorize_account failed (${res.status})`);
  const json = await res.json() as Partial<AuthorizeResponse>;
  if (!json.accountId || !json.authorizationToken || !json.apiUrl) {
    throw new Error('b2_authorize_account returned an unexpected payload');
  }
  return json as AuthorizeResponse;
}

async function b2ResolveBucketId(auth: AuthorizeResponse, bucketName: string): Promise<string> {
  const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
    method:  'POST',
    headers: { Authorization: auth.authorizationToken, 'content-type': 'application/json' },
    body:    JSON.stringify({ accountId: auth.accountId, bucketName }),
    cache:   'no-store',
  });
  if (!res.ok) throw new Error(`b2_list_buckets failed (${res.status})`);
  const json = await res.json() as ListBucketsResponse;
  const match = json.buckets?.find(b => b.bucketName === bucketName);
  if (!match) throw new Error(`Bucket "${bucketName}" not found on this B2 account`);
  return match.bucketId;
}

async function b2CreateScopedKey(
  auth: AuthorizeResponse,
  bucketId: string,
  keyName: string,
): Promise<CreateKeyResponse> {
  const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_create_key`, {
    method:  'POST',
    headers: { Authorization: auth.authorizationToken, 'content-type': 'application/json' },
    body:    JSON.stringify({
      accountId:              auth.accountId,
      capabilities:           ['listFiles', 'readFiles', 'writeFiles', 'deleteFiles', 'shareFiles', 'listBuckets'],
      keyName,
      bucketId,
      validDurationInSeconds: KEY_TTL_SECONDS,
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`b2_create_key failed (${res.status}): ${text}`);
  }
  return await res.json() as CreateKeyResponse;
}

export async function POST(req: NextRequest) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const masterKeyId   = process.env.B2_MEDIA_KEY_ID?.trim();
  const masterAppKey  = process.env.B2_MEDIA_APPLICATION_KEY?.trim();
  const endpoint      = process.env.B2_MEDIA_ENDPOINT?.trim();
  const bucketName    = process.env.B2_MEDIA_BUCKET?.trim();

  if (!masterKeyId || !masterAppKey || !endpoint || !bucketName) {
    return NextResponse.json(
      { ok: false, error: 'B2 media credentials are not configured on the server' },
      { status: 503 },
    );
  }

  try {
    const b2       = await b2Authorize(masterKeyId, masterAppKey);
    const bucketId = await b2ResolveBucketId(b2, bucketName);
    // keyName must be ≤ 100 chars per b2 spec — sanitise user id + timestamp.
    const safeId   = auth.user.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32);
    const keyName  = `ep-${safeId}-${Date.now()}`.slice(0, 100);
    const key      = await b2CreateScopedKey(b2, bucketId, keyName);

    return NextResponse.json({
      ok: true,
      data: {
        keyId:          key.applicationKeyId,
        applicationKey: key.applicationKey,
        endpoint,
        bucket:         bucketName,
        expiresAt:      new Date(Date.now() + KEY_TTL_SECONDS * 1000).toISOString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 },
    );
  }
}
