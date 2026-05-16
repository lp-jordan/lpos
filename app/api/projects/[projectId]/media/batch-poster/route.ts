import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import { getAsset, patchAsset } from '@/lib/store/media-registry';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png']);
const MAX_BYTES    = 10 * 1024 * 1024;

interface CFImagesUploadResult {
  result?: {
    id: string;
    filename: string;
    variants: string[];
  };
  success: boolean;
  errors?: { code: number; message: string }[];
}

function pickVariantUrl(variants: string[]): string | null {
  if (!variants.length) return null;
  const preferred = process.env.CLOUDFLARE_IMAGES_VARIANT?.trim() || 'public';
  const match = variants.find((u) => u.endsWith(`/${preferred}`));
  return match ?? variants[0];
}

type Ctx = { params: Promise<{ projectId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const { projectId } = await params;

  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
    ?? process.env.CLOUDFLARE_STREAM_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_IMAGES_API_TOKEN
    ?? process.env.CLOUDFLARE_STREAM_API_TOKEN
    ?? process.env.CLOUDFLARE_STREAM_TOKEN;
  if (!accountId || !apiToken) {
    return NextResponse.json(
      { error: 'Cloudflare Images is not configured (need CLOUDFLARE_ACCOUNT_ID + a token with Images:Edit — CLOUDFLARE_IMAGES_API_TOKEN, or the existing CLOUDFLARE_STREAM_API_TOKEN with Images:Edit added)' },
      { status: 500 },
    );
  }

  const form = await req.formData();
  const file = form.get('image');
  const assetIdsRaw = form.get('assetIds');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'image field is required' }, { status: 400 });
  }
  if (typeof assetIdsRaw !== 'string') {
    return NextResponse.json({ error: 'assetIds field is required' }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ error: 'Only JPG or PNG images are supported' }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `Image exceeds maximum size of ${MAX_BYTES} bytes` }, { status: 413 });
  }

  let assetIds: string[];
  try {
    const parsed = JSON.parse(assetIdsRaw);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) throw new Error();
    assetIds = parsed;
  } catch {
    return NextResponse.json({ error: 'assetIds must be a JSON array of strings' }, { status: 400 });
  }
  if (!assetIds.length) {
    return NextResponse.json({ error: 'assetIds is empty' }, { status: 400 });
  }

  const cfForm = new FormData();
  cfForm.append('file', file, file.name);
  cfForm.append('metadata', JSON.stringify({ projectId, source: 'lpos-batch-poster' }));
  cfForm.append('requireSignedURLs', 'false');

  let posterUrl: string;
  let imageId:   string;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`,
      { method: 'POST', headers: { Authorization: `Bearer ${apiToken}` }, body: cfForm },
    );
    const data = await res.json() as CFImagesUploadResult;
    if (!res.ok || !data.success || !data.result) {
      const detail = data.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${res.status}`;
      console.error('[batch-poster] Cloudflare Images upload failed:', detail);
      return NextResponse.json({ error: `Cloudflare Images upload failed: ${detail}` }, { status: 502 });
    }
    const url = pickVariantUrl(data.result.variants);
    if (!url) {
      return NextResponse.json({ error: 'Cloudflare Images returned no variant URLs' }, { status: 502 });
    }
    posterUrl = url;
    imageId   = data.result.id;
  } catch (err) {
    console.error('[batch-poster] Cloudflare Images upload threw:', err);
    return NextResponse.json({ error: 'Failed to reach Cloudflare Images' }, { status: 502 });
  }

  const updated: string[]                                      = [];
  const failed:  { assetId: string; reason: string }[]         = [];

  for (const assetId of assetIds) {
    const asset = getAsset(projectId, assetId);
    if (!asset) {
      failed.push({ assetId, reason: 'Asset not found' });
      continue;
    }
    const patched = patchAsset(projectId, assetId, { cloudflare: { posterUrl } });
    if (patched) updated.push(assetId);
    else failed.push({ assetId, reason: 'Patch returned null' });
  }

  return NextResponse.json({
    ok:        true,
    posterUrl,
    imageId,
    updated:   updated.length,
    failed,
  });
}
