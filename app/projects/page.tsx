import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById, toUserSummary, getAllUsers } from '@/lib/store/user-store';
import { getProjectStore, getClientOwnerStore } from '@/lib/services/container';
import { getClientStats } from '@/lib/services/client-stats';
import { getLatestActivityByProject } from '@/lib/store/activity-db';
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

  // Most-recent-activity timestamp per project, derived from the activity_events
  // table so the client-list "Most Recent Activity" sort reflects every event
  // type uniformly (uploads, scripts, photos, deliveries, Cloudflare ready,
  // comments — the lot) without requiring a `touch()` call at every emit site.
  const latestActivity = Object.fromEntries(
    getLatestActivityByProject(projects.map((p) => p.projectId)),
  );

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
      initialLatestActivity={latestActivity}
    />
  );
}
