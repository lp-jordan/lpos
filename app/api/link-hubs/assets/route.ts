import { NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import { listCanonicalMediaAssets } from '@/lib/store/canonical-asset-store';

export interface HubAssetOption {
  assetId: string;
  projectId: string;
  projectName: string;
  clientName: string;
  name: string;
  durationS: number;
  thumbnailUrl: string | null;
  cfStatus: string | null;
}

/**
 * GET /api/link-hubs/assets — every video that can go in a hub: finished assets
 * across all projects that have a Cloudflare Stream UID (i.e. are playable by the
 * delivery app). The "add videos" picker reads this.
 */
export async function GET() {
  try {
    const projects = getProjectStore().getAll();
    const out: HubAssetOption[] = [];

    for (const project of projects) {
      if (project.archived) continue;
      const assets = listCanonicalMediaAssets(project.projectId);
      for (const asset of assets) {
        // Only assets the delivery app can actually play (have a CF Stream UID).
        if (!asset.cloudflare?.uid) continue;
        out.push({
          assetId: asset.assetId,
          projectId: project.projectId,
          projectName: project.name,
          clientName: project.clientName ?? '',
          name: asset.name,
          durationS: Math.round(asset.duration ?? 0),
          thumbnailUrl: asset.cloudflare?.thumbnailUrl ?? null,
          cfStatus: asset.cloudflare?.status ?? null,
        });
      }
    }

    // group-friendly ordering: client, then project, then name
    out.sort(
      (a, b) =>
        a.clientName.localeCompare(b.clientName) ||
        a.projectName.localeCompare(b.projectName) ||
        a.name.localeCompare(b.name),
    );

    return NextResponse.json({ assets: out });
  } catch (err) {
    return NextResponse.json({ assets: [], error: (err as Error).message }, { status: 500 });
  }
}
