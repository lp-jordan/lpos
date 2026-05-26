import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { hasProspectsAccess, getUsersWithProspectsAccess } from '@/lib/store/prospect-access-store';
import { getAllUsers, toUserSummary } from '@/lib/store/user-store';
import { getProspectStore, getClientStore } from '@/lib/services/container';
import type { UserSummary } from '@/lib/models/user';
import { OrgDetailClient } from './OrgDetailClient';

type Ctx = { params: Promise<{ clientId: string }> };

export default async function OrgDetailPage({ params }: Ctx) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) redirect('/signin');

  const isAdmin = session.role === 'admin';
  if (!hasProspectsAccess(session.userId, isAdmin)) redirect('/');

  const { clientId } = await params;
  const client = getClientStore().getAll().find((c) => c.clientId === clientId);
  if (!client || !client.isParent) redirect('/people');

  const allProspects = getProspectStore().getAll({ includeArchived: false });
  const engagements  = allProspects.filter(
    (p) => p.clientName === client.name && (p.status === 'active' || p.status === 'inactive'),
  );

  const accessUsers: UserSummary[] = isAdmin
    ? getAllUsers().map(toUserSummary).filter((u): u is UserSummary => u !== null && !u.isGuest)
    : getUsersWithProspectsAccess();

  return (
    <OrgDetailClient
      client={client}
      engagements={engagements}
      accessUsers={accessUsers}
    />
  );
}
