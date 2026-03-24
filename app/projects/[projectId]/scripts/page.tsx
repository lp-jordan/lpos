import { notFound } from 'next/navigation';
import { AssetList } from '@/components/projects/AssetList';
import { ProjectHeader } from '@/components/projects/ProjectHeader';
import { getProjectAssets, getProjectById } from '@/lib/selectors/projects';

export default async function ProjectScriptsPage({ params }: Readonly<{ params: Promise<{ projectId: string }> }>) {
  const { projectId } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const scriptAssets = getProjectAssets(projectId).filter((asset) => asset.type === 'script');

  return (
    <div className="page-stack">
      <ProjectHeader project={project} />
      <section className="panel">
        <AssetList items={scriptAssets} />
      </section>
    </div>
  );
}
