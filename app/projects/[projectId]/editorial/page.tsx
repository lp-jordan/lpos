import { notFound } from 'next/navigation';
import { JobList } from '@/components/projects/JobList';
import { ProjectHeader } from '@/components/projects/ProjectHeader';
import { getProjectById, getProjectJobs } from '@/lib/selectors/projects';

export default async function ProjectEditorialPage({ params }: Readonly<{ params: Promise<{ projectId: string }> }>) {
  const { projectId } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const editorialJobs = getProjectJobs(projectId).filter((job) => job.type === 'editpanel_task');

  return (
    <div className="page-stack">
      <ProjectHeader project={project} />
      <section className="panel">
        <JobList items={editorialJobs} />
      </section>
    </div>
  );
}
