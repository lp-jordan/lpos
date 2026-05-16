import { NextRequest, NextResponse } from 'next/server';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

function getS3(): S3Client {
  return new S3Client({
    region:   'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

type Ctx = { params: Promise<{ key: string[] }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { key: keyParts } = await params;
  const key = keyParts.join('/');

  if (!key.startsWith('posters/')) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  }

  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    return NextResponse.json({ error: 'R2 storage is not configured' }, { status: 500 });
  }

  try {
    const res = await getS3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) return NextResponse.json({ error: 'Empty object' }, { status: 404 });

    const stream = res.Body as Readable;
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        stream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        stream.on('end',  () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
    });

    const headers = new Headers();
    headers.set('Content-Type',  res.ContentType ?? 'application/octet-stream');
    headers.set('Cache-Control', res.CacheControl ?? 'public, max-age=31536000, immutable');
    if (res.ContentLength != null) headers.set('Content-Length', String(res.ContentLength));
    if (res.ETag) headers.set('ETag', res.ETag);

    return new NextResponse(webStream, { status: 200, headers });
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NoSuchKey' || name === 'NotFound') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    console.error('[posters proxy] R2 fetch failed:', err);
    return NextResponse.json({ error: 'Failed to fetch poster' }, { status: 502 });
  }
}
