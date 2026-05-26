import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { getClientStore } from '@/lib/services/container';

/** GET /api/clients — returns all client records.
 *  Used by the PromoteModal to populate the "Add to existing client" dropdown. */
export async function GET(req: NextRequest) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const clients = getClientStore().getAll();
  return NextResponse.json({ clients });
}
