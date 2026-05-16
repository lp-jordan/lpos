import Link from 'next/link';
import { projectHref } from '@/lib/urls/project-url';

const links = [
  { slug: '', label: 'Overview' },
  { slug: 'scripts', label: 'Scripts' },
  { slug: 'shoot', label: 'Shoot' },
  { slug: 'transcripts', label: 'Transcripts' },
  { slug: 'editorial', label: 'Editorial' },
  { slug: 'pass-prep', label: 'Pass Prep' },
  { slug: 'delivery', label: 'Delivery' }
];

export function ProjectWorkflowNav({ clientName, projectId, active }: Readonly<{ clientName: string; projectId: string; active: string }>) {
  return (
    <nav className="workflow-nav" aria-label="Project workflow">
      {links.map((link) => {
        const href = projectHref(clientName, projectId, link.slug || undefined);
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
