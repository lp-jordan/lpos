import { NextRequest, NextResponse } from 'next/server';
import { readRegistry } from '@/lib/store/media-registry';
import { createShareLink } from '@/lib/services/frameio';
import { setShareAssets } from '@/lib/store/share-assets-store';
import { addAssetShareLink } from '@/lib/store/asset-share-links-store';

/**
 * POST /api/projects/[projectId]/media/share
 *
 * Body: { assetIds: string[], name?: string }
 *
 * Looks up the Frame.io file IDs for each LPOS asset, creates a Frame.io
 * share presentation containing all of them, and returns the share URL.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const body = await req.json() as { assetIds?: string[]; name?: string };

    const { assetIds, name } = body;
    if (!assetIds?.length) {
      return NextResponse.json({ error: 'assetIds is required' }, { status: 400 });
    }

    const assets = readRegistry(projectId);

    // Collect Frame.io file IDs for the requested assets
    const fileIds: string[] = [];
    const missing: string[] = [];

    for (const assetId of assetIds) {
      const asset = assets.find((a) => a.assetId === assetId);
      if (asset?.frameio.assetId) {
        fileIds.push(asset.frameio.assetId);
      } else {
        missing.push(assetId);
      }
    }

    if (!fileIds.length) {
      return NextResponse.json(
        { error: 'None of the selected assets have been uploaded to Frame.io yet.' },
        { status: 400 },
      );
    }

    if (missing.length) {
      console.warn(
        `[share] ${missing.length} asset(s) skipped — not yet on Frame.io: ${missing.join(', ')}`,
      );
    }

    const shareName = name?.trim() ||
      `Share — ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const share = await createShareLink(fileIds, shareName);

    // Track the share so it persists and can be retrieved per-asset later
    setShareAssets(projectId, share.id, fileIds);

    const now = new Date().toISOString();
    for (const assetId of assetIds) {
      addAssetShareLink(projectId, assetId, {
        shareId:   share.id,
        shareUrl:  share.shareUrl,
        name:      shareName,
        createdAt: now,
      });
    }

    return NextResponse.json({ shareUrl: share.shareUrl, shareId: share.id, fileCount: fileIds.length, skipped: missing.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[share] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
