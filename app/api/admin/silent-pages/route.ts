import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getAsset } from '@/lib/store/media-registry';
import {
  getSilentPageSelection,
  setSilentPageSelection,
  clearSilentPageSelection,
} from '@/lib/store/silent-pages-store';
import {
  SILENT_PAGE_SLUGS,
  SILENT_PAGE_LABELS,
  isBrowserPlayable,
  isSilentPageSlug,
  silentPagePath,
  type SilentPageSlug,
} from '@/lib/silent-pages';

/**
 * Admin API for the silent display pages — which asset each of
 * /silent-structure, /silent-produce and /silent-place loops.
 *
 * GET resolves each selection to project/asset names so the settings panel can
 * show what's currently pointed where without a second round of fetches, and
 * flags selections whose file the browser won't decode.
 */

interface ResolvedPage {
  slug:        SilentPageSlug;
  label:       string;
  path:        string;
  projectId:   string | null;
  projectName: string | null;
  assetId:     string | null;
  assetName:   string | null;
  /** True when the selected file's extension is one browsers reliably decode. */
  playable:    boolean;
  /** True when a selection exists but its asset is gone from the registry. */
  missing:     boolean;
}

function resolve(slug: SilentPageSlug): ResolvedPage {
  const base = {
    slug,
    label: SILENT_PAGE_LABELS[slug],
    path:  silentPagePath(slug),
  };

  const selection = getSilentPageSelection(slug);
  if (!selection) {
    return { ...base, projectId: null, projectName: null, assetId: null, assetName: null, playable: false, missing: false };
  }

  const asset = getAsset(selection.projectId, selection.assetId);
  const project = getProjectStore().getById(selection.projectId);

  return {
    ...base,
    projectId:   selection.projectId,
    projectName: project?.name ?? null,
    assetId:     selection.assetId,
    assetName:   asset?.name ?? null,
    playable:    isBrowserPlayable(asset?.filePath ?? asset?.originalFilename ?? null),
    missing:     !asset,
  };
}

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;
  return NextResponse.json({ pages: SILENT_PAGE_SLUGS.map(resolve) });
}

export async function PUT(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  let body: { slug?: unknown; projectId?: unknown; assetId?: unknown; clear?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body.slug !== 'string' || !isSilentPageSlug(body.slug)) {
    return NextResponse.json({ error: 'Unknown silent page.' }, { status: 400 });
  }
  const slug = body.slug;

  if (body.clear === true) {
    clearSilentPageSelection(slug);
    return NextResponse.json({ page: resolve(slug) });
  }

  if (typeof body.projectId !== 'string' || typeof body.assetId !== 'string' || !body.projectId || !body.assetId) {
    return NextResponse.json({ error: 'projectId and assetId are required.' }, { status: 400 });
  }

  // Validate up front — a display screen showing a 404 is worse than a rejected save.
  const asset = getAsset(body.projectId, body.assetId);
  if (!asset) {
    return NextResponse.json({ error: 'Asset not found in that project.' }, { status: 404 });
  }
  if (!asset.filePath) {
    return NextResponse.json({ error: 'That asset has no local file to stream.' }, { status: 400 });
  }

  setSilentPageSelection(slug, { projectId: body.projectId, assetId: body.assetId });
  return NextResponse.json({ page: resolve(slug) });
}
