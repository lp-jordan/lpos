import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ProjectDetail } from '@/components/projects/ProjectDetail';
import { getProjectAssets, getProjectById } from '@/lib/selectors/projects';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';

export default async function ProjectPage({ params }: Readonly<{ params: Promise<{ clientName: string; projectId: string }> }>) {
  const { projectId } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const assets = getProjectAssets(projectId);

  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const isAdmin = session?.role === 'admin';

  return <ProjectDetail project={project} assets={assets} isAdmin={isAdmin} />;
}
