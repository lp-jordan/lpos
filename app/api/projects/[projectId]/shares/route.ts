import { NextRequest, NextResponse } from 'next/server';
import { readRegistry } from '@/lib/store/media-registry';
import { listShares, createShareLink } from '@/lib/services/frameio';
import { getAllShareAssets, setShareAssets } from '@/lib/store/share-assets-store';

type Params = { params: Promise<{ projectId: string }> };

/**
 * GET /api/projects/[projectId]/shares
 *
 * Lists all Frame.io share presentations for the project.
 * Each share is enriched with LPOS asset names by matching
 * frameio.assetId → Frame.io file ID.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { projectId } = await params;

    const [allShares, localShares] = await Promise.all([
      listShares(),
      Promise.resolve(getAllShareAssets(projectId)),
    ]);

    // Filter to shares belonging to this project (tracked in local store).
    // Also filter out per-asset auto-review links shown in the asset detail panel instead.
    // Enrich with fileCount from local store; treat empty arrays as untracked (null = "—").
    const shares = allShares
      .filter((s) => !s.name.startsWith('Review — '))
      .filter((s) => s.id in localShares)
      .map((s) => ({
        ...s,
        fileCount: (localShares[s.id]?.length ?? 0) > 0 ? localShares[s.id].length : null,
      }));

    // Build a lookup: frameio file ID → LPOS asset name
    const assets  = readRegistry(projectId);
    const nameMap = new Map<string, string>();
    for (const a of assets) {
      if (a.frameio.assetId) nameMap.set(a.frameio.assetId, a.name);
    }

    return NextResponse.json({ shares, nameMap: Object.fromEntries(nameMap) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[shares GET] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/projects/[projectId]/shares
 *
 * Body: { assetIds: string[], name?: string }
 *
 * Creates a new Frame.io share presentation with the given LPOS asset IDs.
 * Assets not yet uploaded to Frame.io are skipped.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { projectId } = await params;
    const body = await req.json() as {
      assetIds?:            string[];
      name?:                string;
      downloading_enabled?: boolean;
    };

    const { assetIds = [], name } = body;
    const assets = readRegistry(projectId);

    const fileIds: string[] = [];
    for (const assetId of assetIds) {
      const asset = assets.find((a) => a.assetId === assetId);
      if (asset?.frameio.assetId) fileIds.push(asset.frameio.assetId);
    }

    const shareName = name?.trim() ||
      `Share — ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const share = await createShareLink(fileIds, shareName, {
      downloading_enabled: body.downloading_enabled,
    });

    // Record asset membership locally — V4 API has no list endpoint
    setShareAssets(projectId, share.id, fileIds);

    return NextResponse.json({ share, skipped: assetIds.length - fileIds.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[shares POST] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
