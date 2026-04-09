import Link from 'next/link';
import { getProjectStore } from '@/lib/services/container';

export default function GuestScriptsPage() {
  const projects = getProjectStore().getAll().filter((p) => !p.archived);

  return (
    <div className="home-hero">
      <div className="home-brand">
        <h1 className="home-title">Script Upload</h1>
        <p className="home-subtitle">Choose a project</p>
      </div>

      <div className="home-tiles home-tiles--wrap">
        {projects.length === 0 && (
          <p style={{ color: 'var(--color-text-muted, #888)', fontSize: '0.875rem' }}>
            No active projects found.
          </p>
        )}
        {projects.map((project) => (
          <Link
            key={project.projectId}
            href={`/projects/${project.projectId}/scripts`}
            className="home-tile"
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
            <span className="home-tile-label" style={{ fontSize: '0.85rem', textAlign: 'center', wordBreak: 'break-word', width: '100%', padding: '0 10px' }}>
              {project.name}
            </span>
            {project.clientName && (
              <span style={{ fontSize: '0.65rem', opacity: 0.5, marginTop: '0.1rem', textAlign: 'center', wordBreak: 'break-word', width: '100%', padding: '0 10px' }}>
                {project.clientName}
              </span>
            )}
          </Link>
        ))}
      </div>

      <div className="home-divider" />

      <Link href="/guest" style={{ fontSize: '0.8rem', color: 'var(--color-text-muted, #888)' }}>
        ← Back
      </Link>
    </div>
  );
}
