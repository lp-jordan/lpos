import Link from 'next/link';

const links = [
  { slug: '', label: 'Overview' },
  { slug: 'scripts', label: 'Scripts' },
  { slug: 'shoot', label: 'Shoot' },
  { slug: 'transcripts', label: 'Transcripts' },
  { slug: 'editorial', label: 'Editorial' },
  { slug: 'pass-prep', label: 'Pass Prep' },
  { slug: 'delivery', label: 'Delivery' }
];

export function ProjectWorkflowNav({ projectId, active }: Readonly<{ projectId: string; active: string }>) {
  return (
    <nav className="workflow-nav" aria-label="Project workflow">
      {links.map((link) => {
        const href = link.slug ? `/projects/${projectId}/${link.slug}` : `/projects/${projectId}`;
        const isActive = active === link.slug || (active === 'overview' && link.slug === '');
        return (
          <Link key={href} href={href} className={`workflow-link${isActive ? ' active' : ''}`}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
