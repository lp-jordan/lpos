import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById, toUserSummary, getAllUsers } from '@/lib/store/user-store';
import { getProjectStore, getClientOwnerStore } from '@/lib/services/container';
import { getClientStats } from '@/lib/services/client-stats';
import { ProjectsPageClient } from './ProjectsPageClient';
import type { UserSummary } from '@/lib/models/user';

export default async function ProjectsPage() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const currentUser = toUserSummary(session ? getUserById(session.userId) : null);

  const projects = getProjectStore().getAll();
  const owners = getClientOwnerStore().getAll();
  const users = getAllUsers().map(toUserSummary).filter((u): u is UserSummary => u !== null);
  const stats = getClientStats();

  const { getClientStore } = await import('@/lib/services/container');
  const promotedClients = getClientStore().getAll().map((c) => c.name);

  return (
    <ProjectsPageClient
      initialProjects={projects}
      initialOwners={owners}
      initialUsers={users}
      initialStats={stats}
      initialCurrentUser={currentUser}
      initialPromotedClients={promotedClients}
    />
  );
}
