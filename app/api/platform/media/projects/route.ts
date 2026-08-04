import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getProjectStore } from '@/lib/services/container';
import { readRegistry } from '@/lib/store/media-registry';

/** Projects (with media counts) for the tile media picker. */
export async function GET() {
  const cookieStore = await cookies();
  if (!(await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const projects = getProjectStore().getAll().map((p) => ({
    projectId: p.projectId,
    name: p.name,
    clientName: p.clientName,
    assetCount: readRegistry(p.projectId).length,
  }));
  return NextResponse.json({ projects });
}
