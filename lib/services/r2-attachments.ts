import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const accessKey = process.env.R2_ATTACHMENTS_ACCESS_KEY_ID?.trim();
  const secretKey = process.env.R2_ATTACHMENTS_SECRET_ACCESS_KEY?.trim();
  if (!accountId || !accessKey || !secretKey) {
    throw new Error('[r2-attachments] Missing R2 credentials (CLOUDFLARE_ACCOUNT_ID / R2_ATTACHMENTS_ACCESS_KEY_ID / R2_ATTACHMENTS_SECRET_ACCESS_KEY)');
  }
  _client = new S3Client({
    region:      'auto',
    endpoint:    `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  return _client;
}

function getBucket(): string {
  const b = process.env.R2_ATTACHMENTS_BUCKET?.trim();
  if (!b) throw new Error('[r2-attachments] R2_ATTACHMENTS_BUCKET not set');
  return b;
}

export async function uploadAttachment(
  key:         string,
  body:        Buffer,
  contentType: string,
): Promise<void> {
  await getClient().send(new PutObjectCommand({
    Bucket:      getBucket(),
    Key:         key,
    Body:        body,
    ContentType: contentType,
  }));
}

export async function fetchAttachment(
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return { bytes, contentType: res.ContentType ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

export async function deleteAttachment(key: string): Promise<void> {
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
  } catch {
    // best-effort; 60-day lifecycle handles orphans
  }
}
