import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getProjectById } from '@/lib/selectors/projects';
import { getAsset } from '@/lib/store/media-registry';

export async function GET(req: NextRequest) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const raw = req.nextUrl.searchParams.get('url') ?? '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return NextResponse.json({ label: null });
  }

  const segs    = parsed.pathname.split('/').filter(Boolean);
  const assetId = parsed.searchParams.get('assetId') ?? null;

  // /projects/[projectId]  (short format — used by copy-link button)
  if (segs[0] === 'projects' && segs[1] && segs.length === 2) {
    const projectId = segs[1];
    const project   = getProjectById(projectId);
    if (!project) return NextResponse.json({ label: null });

    if (assetId) {
      const asset = getAsset(projectId, assetId);
      const assetName = asset?.name ?? asset?.originalFilename ?? null;
      return NextResponse.json({
        label: assetName ? `${project.clientName}: ${assetName}` : `${project.clientName}: Project`,
      });
    }
    return NextResponse.json({ label: `${project.clientName}: Project` });
  }

  // /projects/clients/[clientName]/[projectId]/[sub?]  (canonical format)
  if (segs[0] === 'projects' && segs[1] === 'clients' && segs[2]) {
    const clientName = decodeURIComponent(segs[2]);
    const sub        = segs[4] ? (segs[4][0].toUpperCase() + segs[4].slice(1).replace(/-/g, ' ')) : 'Project';
    return NextResponse.json({ label: `${clientName}: ${sub}` });
  }

  return NextResponse.json({ label: null });
}
