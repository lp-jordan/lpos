'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Project } from '@/lib/models/project';

const ROOT_LABELS: Record<string, string> = {
  projects: 'Projects',
  media: 'Media',
  slate: 'Studio',
};

export function Breadcrumb() {
  const pathname = usePathname();
  const router   = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.ok ? r.json() : { projects: [] })
      .then((data: { projects?: Project[] }) => setProjects(data.projects ?? []))
      .catch(() => {});
  }, []);

  const segments = pathname.split('/').filter(Boolean);

  if (segments.length === 0) return null;

  const crumbs = segments.map((seg, i) => {
    const href = '/' + segments.slice(0, i + 1).join('/');
    let label = ROOT_LABELS[seg];
    if (!label) {
      const project = projects.find((p) => p.projectId === seg);
      label = project ? project.name : seg;
    }
    return { label, href, isLast: i === segments.length - 1 };
  });

  return (
    <nav className="breadcrumb-bar" aria-label="Breadcrumb">
      <button
        type="button"
        className="breadcrumb-back"
        onClick={() => router.back()}
        aria-label="Go back"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
      <Link href="/" className="breadcrumb-home" aria-label="Home">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
          <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
        </svg>
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.href} className="breadcrumb-item">
          <span className="breadcrumb-sep">/</span>
          {crumb.isLast
            ? <span className="breadcrumb-current">{crumb.label}</span>
            : <Link href={crumb.href} className="breadcrumb-link">{crumb.label}</Link>
          }
        </span>
      ))}
    </nav>
  );
}
