'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavBar({ hasProspects = false }: { hasProspects?: boolean }) {
  const pathname = usePathname();

  const mainNav = [
    { href: '/projects', label: 'Projects' },
    { href: '/platform', label: 'Platform' },
    ...(hasProspects ? [{ href: '/people', label: 'People' }] : []),
  ];

  const tabNav = [
    {
      href: '/', label: 'Home', exact: true,
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>,
    },
    {
      href: '/projects', label: 'Projects', exact: false,
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></svg>,
    },
    {
      href: '/platform', label: 'Platform', exact: false,
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="2" y1="20" x2="22" y2="20" /><line x1="6" y1="20" x2="6" y2="17" /><line x1="18" y1="20" x2="18" y2="17" /></svg>,
    },
    ...(hasProspects ? [{
      href: '/people', label: 'People', exact: false,
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
    }] : []),
    {
      href: '/slate', label: 'Studio', exact: false,
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" /></svg>,
    },
  ];

  function isActive(href: string, exact: boolean) {
    return exact ? pathname === href : pathname.startsWith(href);
  }

  return (
    <>
      {/* Desktop: floating pill navbar */}
      <nav className="navbar">
        <div className="navbar-pill">
          <Link href="/" className="navbar-home" aria-label="Home">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
              <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
            </svg>
          </Link>
          <span className="navbar-sep" />
          {mainNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`navbar-link${(item.href === '/people' ? pathname.startsWith('/people') || pathname.startsWith('/prospects') : pathname.startsWith(item.href)) ? ' active' : ''}`}
            >
              {item.label}
            </Link>
          ))}
          <span className="navbar-divider" />
          <Link href="/slate" className={`navbar-link${pathname.startsWith('/slate') ? ' active' : ''}`}>
            Studio
          </Link>
        </div>
      </nav>

      {/* Mobile: bottom tab bar */}
      <nav className="bottom-tab-bar" aria-label="Main navigation">
        {tabNav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`bottom-tab-item${isActive(item.href, item.exact) ? ' active' : ''}`}
            aria-label={item.label}
          >
            {item.icon}
            <span className="bottom-tab-label">{item.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
