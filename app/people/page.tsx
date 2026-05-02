import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById, toUserSummary, getAllUsers } from '@/lib/store/user-store';
import { hasProspectsAccess, getUsersWithProspectsAccess } from '@/lib/store/prospect-access-store';
import { getProspectStore } from '@/lib/services/container';
import { PeoplePageClient } from './PeoplePageClient';
import type { UserSummary } from '@/lib/models/user';

export default async function PeoplePage() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) redirect('/signin');

  const isAdmin = session.role === 'admin';
  if (!hasProspectsAccess(session.userId, isAdmin)) redirect('/');

  const currentUser = toUserSummary(getUserById(session.userId));

  const store            = getProspectStore();
  const people           = store.getAll({ includeArchived: true });
  const lastUpdateBodies = store.getLastUpdateBodies();
  const accessUsers      = isAdmin
    ? getAllUsers().map(toUserSummary).filter((u): u is UserSummary => u !== null && !u.isGuest)
    : getUsersWithProspectsAccess();

  return (
    <PeoplePageClient
      initialPeople={people}
      currentUserId={session.userId}
      accessUsers={accessUsers}
      lastUpdateBodies={lastUpdateBodies}
    />
  );
}
