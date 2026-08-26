import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import {
  getDeliveryStorageFootprint,
  isDeliveryStorageConfigured,
} from '@/lib/services/delivery-storage-footprint';

/**
 * GET /api/admin/delivery-storage
 *
 * On-demand live footprint of delivery-link media in Cloudflare R2. Walks every
 * object under the `delivery/` prefix and returns total bytes/objects plus a
 * per-token (per-link) breakdown. LPOS keeps no local tally of these objects, so
 * this is the only way to see delivery storage usage without opening the
 * Cloudflare dashboard.
 *
 * Not on any poll: the bucket walk can be slow with many links, so it only runs
 * when an admin clicks "Check delivery storage".
 */
export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  if (!isDeliveryStorageConfigured()) {
    return NextResponse.json(
      { error: 'R2 delivery storage credentials not configured' },
      { status: 503 },
    );
  }

  try {
    const footprint = await getDeliveryStorageFootprint();
    return NextResponse.json({ footprint });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
