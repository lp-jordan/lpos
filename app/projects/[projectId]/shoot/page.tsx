import { notFound } from 'next/navigation';
import { ProjectHeader } from '@/components/projects/ProjectHeader';
import { Timeline } from '@/components/projects/Timeline';
import { getProjectById, getProjectEvents } from '@/lib/selectors/projects';

export default async function ProjectShootPage({ params }: Readonly<{ params: Promise<{ projectId: string }> }>) {
  const { projectId } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const shootEvents = getProjectEvents(projectId);

  return (
    <div className="page-stack">
      <ProjectHeader project={project} />
      <section className="panel">
        <Timeline items={shootEvents} />
      </section>
    </div>
  );
}
