'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Project } from '@/lib/models/project';
import type { Prospect } from '@/lib/models/prospect';

const ROOT_LABELS: Record<string, string> = {
  projects:  'Projects',
  prospects: 'People',
  people:    'People',
  media:     'Media',
  slate:     'Studio',
};

// Sub-route labels under a project page (delivery, editorial, etc.)
const PROJECT_SUB_LABELS: Record<string, string> = {
  delivery:    'Delivery',
  editorial:   'Editorial',
  'pass-prep': 'Pass Prep',
  scripts:     'Scripts',
  shoot:       'Shoot',
  transcripts: 'Transcripts',
  media:       'Media',
};

type Crumb = { label: string; href: string; isLast: boolean };

export function Breadcrumb() {
  const pathname = usePathname();
  const router   = useRouter();
  const [projects,  setProjects]  = useState<Project[]>([]);
  const [prospects, setProspects] = useState<Prospect[]>([]);

  useEffect(() => {
    // Refetch on every pathname change so a newly-created project / prospect
    // resolves to its name immediately, rather than falling through to the raw
    // UUID segment until the user manually refreshes.
    fetch('/api/projects')
      .then((r) => r.ok ? r.json() : { projects: [] })
      .then((data: { projects?: Project[] }) => setProjects(data.projects ?? []))
      .catch(() => {});
    fetch('/api/prospects')
      .then((r) => r.ok ? r.json() : { prospects: [] })
      .then((data: { prospects?: Prospect[] }) => setProspects(data.prospects ?? []))
      .catch(() => {});
  }, [pathname]);

  const segments = pathname.split('/').filter(Boolean);

  if (segments.length === 0) return null;

  // Special-case the projects hierarchy:
  //   /projects                                              → Projects
  //   /projects/clients/<clientName>                         → Projects → <Client>
  //   /projects/clients/<clientName>/<projectId>             → Projects → <Client> → <Project>
  //   /projects/clients/<clientName>/<projectId>/<sub>       → Projects → <Client> → <Project> → <Sub>
  // The literal 'clients' segment is hidden — it's a routing artifact, not a navigable level.
  let crumbs: Crumb[];
  if (segments[0] === 'projects' && segments[1] === 'clients' && segments.length >= 3) {
    const clientEnc  = segments[2];
    const clientName = decodeURIComponent(clientEnc);
    const totalDisplayed = 1 + 1 + (segments[3] ? 1 : 0) + (segments[4] ? 1 : 0);

    crumbs = [
      { label: 'Projects', href: '/projects', isLast: totalDisplayed === 1 },
      { label: clientName, href: `/projects/clients/${clientEnc}`, isLast: totalDisplayed === 2 },
    ];
    if (segments[3]) {
      const projectId = segments[3];
      const project   = projects.find((p) => p.projectId === projectId);
      crumbs.push({
        label:  project?.name ?? projectId,
        href:   `/projects/clients/${clientEnc}/${projectId}`,
        isLast: totalDisplayed === 3,
      });
      if (segments[4]) {
        crumbs.push({
          label:  PROJECT_SUB_LABELS[segments[4]] ?? segments[4],
          href:   `/projects/clients/${clientEnc}/${projectId}/${segments[4]}`,
          isLast: true,
        });
      }
    }
  } else {
    crumbs = segments.map((seg, i) => {
      const href = '/' + segments.slice(0, i + 1).join('/');
      let label = ROOT_LABELS[seg];
      if (!label) {
        const project  = projects.find((p) => p.projectId === seg);
        const prospect = prospects.find((p) => p.prospectId === seg);
        label = project?.name ?? prospect?.company ?? seg;
      }
      return { label, href, isLast: i === segments.length - 1 };
    });
  }

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
