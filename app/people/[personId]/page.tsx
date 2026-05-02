import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getAllUsers, getUserById, toUserSummary } from '@/lib/store/user-store';
import { hasProspectsAccess, getUsersWithProspectsAccess } from '@/lib/store/prospect-access-store';
import { getProspectStore } from '@/lib/services/container';
import { PersonDetailClient } from './PersonDetailClient';
import type { UserSummary } from '@/lib/models/user';

export default async function PersonDetailPage({
  params,
}: {
  params: Promise<{ personId: string }>;
}) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) redirect('/signin');

  const isAdmin = session.role === 'admin';
  if (!hasProspectsAccess(session.userId, isAdmin)) redirect('/');

  const { personId } = await params;
  const store  = getProspectStore();
  const person = store.getById(personId);
  if (!person) notFound();

  const contacts      = store.getContacts(personId);
  const statusHistory = store.getStatusHistory(personId);
  const initialUpdates = store.getUpdates(personId);
  const currentUser   = toUserSummary(getUserById(session.userId));

  const accessUsers: UserSummary[] = isAdmin
    ? getAllUsers().map(toUserSummary).filter((u): u is UserSummary => u !== null && !u.isGuest)
    : getUsersWithProspectsAccess();

  const allUsers: UserSummary[] = getAllUsers()
    .map(toUserSummary)
    .filter((u): u is UserSummary => u !== null && !u.isGuest);

  return (
    <PersonDetailClient
      initialPerson={person}
      initialContacts={contacts}
      initialStatusHistory={statusHistory}
      initialUpdates={initialUpdates}
      accessUsers={accessUsers}
      allUsers={allUsers}
      currentUser={currentUser}
    />
  );
}
