import { NextRequest, NextResponse } from 'next/server';
import { listHubs, createHub, type HubOwnerType } from '@/lib/store/link-hubs-db';

const OWNER_TYPES: HubOwnerType[] = ['client', 'person', 'leaderpass'];

/** GET /api/link-hubs — list all hubs with video + access counts. */
export async function GET() {
  try {
    return NextResponse.json({ hubs: listHubs() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** POST /api/link-hubs — create a hub. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      owner_label?: string;
      owner_type?: string;
      firstEmail?: string;
    };
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const owner_type = OWNER_TYPES.includes(body.owner_type as HubOwnerType)
      ? (body.owner_type as HubOwnerType)
      : 'client';
    const hub = createHub({
      name: body.name,
      owner_label: body.owner_label ?? body.name,
      owner_type,
      firstEmail: body.firstEmail,
    });
    return NextResponse.json({ hub }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
