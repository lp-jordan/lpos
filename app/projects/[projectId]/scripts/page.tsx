import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ProjectHeader } from '@/components/projects/ProjectHeader';
import { ScriptsTab } from '@/components/projects/ScriptsTab';
import { getProjectById } from '@/lib/selectors/projects';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';

export default async function ProjectScriptsPage({ params }: Readonly<{ params: Promise<{ projectId: string }> }>) {
  const { projectId } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const isGuest = session?.role === 'guest';

  return (
    <div className="page-stack">
      <ProjectHeader project={project} />
      <section className="panel">
        <ScriptsTab projectId={projectId} readOnly={isGuest} />
      </section>
    </div>
  );
}
