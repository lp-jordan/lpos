import { notFound } from 'next/navigation';
import { ProjectDetail } from '@/components/projects/ProjectDetail';
import { getProjectAssets, getProjectById } from '@/lib/selectors/projects';

export default async function ProjectPage({ params }: Readonly<{ params: Promise<{ projectId: string }> }>) {
  const { projectId } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const assets = getProjectAssets(projectId);

  return <ProjectDetail project={project} assets={assets} />;
}
