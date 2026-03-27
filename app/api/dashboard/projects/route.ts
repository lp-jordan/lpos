import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getClientOwnerStore, getProjectStore } from '@/lib/services/container';

export async function GET() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const owners = getClientOwnerStore().getAll();
  const ownedClients = Object.entries(owners)
    .filter(([, uid]) => uid === session.userId)
    .map(([clientName]) => clientName);

  const projects = getProjectStore()
    .getAll()
    .filter((p) => !p.archived && ownedClients.includes(p.clientName));

  return NextResponse.json({ projects });
}
