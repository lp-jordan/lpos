import { notFound } from 'next/navigation';
import { AssetList } from '@/components/projects/AssetList';
import { ProjectHeader } from '@/components/projects/ProjectHeader';
import { getProjectAssets, getProjectById } from '@/lib/selectors/projects';

export default async function ProjectPassPrepPage({ params }: Readonly<{ params: Promise<{ projectId: string }> }>) {
  const { projectId } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const prepAssets = getProjectAssets(projectId).filter((asset) =>
    ['project_bundle', 'course_plan', 'workbook'].includes(asset.type)
  );

  return (
    <div className="page-stack">
      <ProjectHeader project={project} />
      <section className="panel">
        <AssetList items={prepAssets} />
      </section>
    </div>
  );
}
