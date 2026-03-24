'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const mainNav = [
  { href: '/', label: 'Dashboard', copy: 'Project health, recent activity, and quick stats.' },
  { href: '/projects', label: 'Projects', copy: 'Open a client project and manage its assets.' },
  { href: '/media', label: 'Media', copy: 'Video library, folders, and cloud delivery.' },
];

const toolNav = [
  { href: '/slate', label: 'Studio', copy: 'Production notes, timecode, ATEM control, and lighting.' },
];

export function Sidebar() {
  const pathname = usePathname();

  function isActive(href: string) {
    return href === '/' ? pathname === '/' : pathname.startsWith(href);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <p className="eyebrow">LeaderPass OS</p>
        <h1 className="sidebar-title">LPOS Dashboard</h1>
        <p className="sidebar-copy">
          A control center for managing client projects, media, and production tools.
        </p>
      </div>
      <nav className="sidebar-nav" aria-label="Primary">
        {mainNav.map((item) => (
          <Link key={item.href} href={item.href} className={`nav-link${isActive(item.href) ? ' active' : ''}`}>
            <span className="nav-label">{item.label}</span>
            <span className="nav-copy">{item.copy}</span>
          </Link>
        ))}
        <div className="sidebar-divider" />
        {toolNav.map((item) => (
          <Link key={item.href} href={item.href} className={`nav-link${isActive(item.href) ? ' active' : ''}`}>
            <span className="nav-label">{item.label}</span>
            <span className="nav-copy">{item.copy}</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
