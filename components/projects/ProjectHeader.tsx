import { Project } from '@/lib/models/project';

export function ProjectHeader({ project }: Readonly<{ project: Project }>) {
  return (
    <div className="project-header">
      <span className="project-header-client">{project.clientName}</span>
      <h1 className="project-header-name">{project.name}</h1>
      <div className="project-header-meta">
        <span>{project.updatedAt}</span>
      </div>
    </div>
  );
}
