import Link from 'next/link';
import { Project } from '@/lib/models/project';

export function ProjectCard({ project }: Readonly<{ project: Project }>) {
  return (
    <article className="project-card">
      <div className="project-card-client">{project.clientName}</div>
      <h2 className="project-card-name">
        <Link href={`/projects/${project.projectId}`}>{project.name}</Link>
      </h2>
      <div className="project-card-meta">
        <span>{project.updatedAt}</span>
      </div>
    </article>
  );
}
