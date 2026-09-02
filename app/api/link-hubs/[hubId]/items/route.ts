import { NextRequest, NextResponse } from 'next/server';
import { getHub, addAssetsToHub } from '@/lib/store/link-hubs-db';
import { pushHubToDelivery, ensureHubVideoOrigins, type PushResult } from '@/lib/services/link-hub-delivery';

type Ctx = { params: Promise<{ hubId: string }> };

/**
 * POST /api/link-hubs/:hubId/items — append assets to a hub (from the Media tab
 * "Add to Link Hub" action). Then whitelist + push, same as a manager save.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { hubId } = await params;
  if (!getHub(hubId)) return NextResponse.json({ error: 'hub not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    items?: Array<{ asset_id?: string; project_id?: string; client_title?: string }>;
  };
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((it) => it && typeof it.asset_id === 'string' && typeof it.project_id === 'string')
    .map((it) => ({
      asset_id: it.asset_id as string,
      project_id: it.project_id as string,
      client_title: (it.client_title ?? '').toString(),
    }));
  if (!items.length) return NextResponse.json({ error: 'no items' }, { status: 400 });

  const { added } = addAssetsToHub(hubId, items);

  // Best-effort: whitelist the leaderpass origin on Cloudflare, then push to delivery.
  ensureHubVideoOrigins(hubId).catch((err) => console.warn('[link-hub] ensureHubVideoOrigins:', (err as Error).message));
  let push: PushResult;
  try {
    push = await pushHubToDelivery(hubId);
  } catch (err) {
    push = { pushed: false, reason: (err as Error).message };
  }

  return NextResponse.json({ added, push });
}
