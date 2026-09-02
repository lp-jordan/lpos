import { NextRequest, NextResponse } from 'next/server';
import { getHubDetail, saveHub, deleteHub, type HubOwnerType } from '@/lib/store/link-hubs-db';
import { pushHubToDelivery, ensureHubVideoOrigins, type PushResult } from '@/lib/services/link-hub-delivery';

type Ctx = { params: Promise<{ hubId: string }> };
const OWNER_TYPES: HubOwnerType[] = ['client', 'person', 'leaderpass'];

/** GET /api/link-hubs/:hubId — hub + its items + access emails. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { hubId } = await params;
  const detail = getHubDetail(hubId);
  if (!detail) return NextResponse.json({ error: 'hub not found' }, { status: 404 });
  return NextResponse.json(detail);
}

/** PUT /api/link-hubs/:hubId — replace videos + access, then push to the delivery app. */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { hubId } = await params;
  if (!getHubDetail(hubId)) return NextResponse.json({ error: 'hub not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    owner_label?: string;
    owner_type?: string;
    items?: Array<{ asset_id?: string; project_id?: string; client_title?: string }>;
    access?: string[];
  };
  if (!body.name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const owner_type = OWNER_TYPES.includes(body.owner_type as HubOwnerType)
    ? (body.owner_type as HubOwnerType)
    : 'client';

  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((it) => it && typeof it.asset_id === 'string' && typeof it.project_id === 'string')
    .map((it) => ({
      asset_id: it.asset_id as string,
      project_id: it.project_id as string,
      client_title: (it.client_title ?? '').toString(),
    }));

  const access = (Array.isArray(body.access) ? body.access : []).filter((e): e is string => typeof e === 'string');

  try {
    const detail = saveHub(hubId, { name: body.name, owner_label: body.owner_label ?? body.name, owner_type, items, access });

    // Best-effort: allow the leaderpass origin on each video's Cloudflare settings.
    ensureHubVideoOrigins(hubId).catch((err) =>
      console.warn('[link-hub] ensureHubVideoOrigins failed:', (err as Error).message),
    );

    // Best-effort push to the delivery app — never fails the save; report the outcome.
    let push: PushResult;
    try {
      push = await pushHubToDelivery(hubId);
    } catch (err) {
      push = { pushed: false, reason: (err as Error).message };
    }

    return NextResponse.json({ ...detail, push });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * DELETE /api/link-hubs/:hubId — remove the hub locally.
 * NOTE (v1): does not yet remove the hub from the delivery app (its ingest is
 * upsert-only). Add a delivery-side delete before exposing this in the UI.
 */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { hubId } = await params;
  deleteHub(hubId);
  return NextResponse.json({ ok: true });
}
