'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const mainNav = [
  { href: '/projects', label: 'Projects' },
  { href: '/media', label: 'Media' },
];

const toolNav = [
  { href: '/slate', label: 'Studio' },
];

export function NavBar() {
  const pathname = usePathname();

  function isActive(href: string) {
    return pathname.startsWith(href);
  }

  return (
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
            className={`navbar-link${isActive(item.href) ? ' active' : ''}`}
          >
            {item.label}
          </Link>
        ))}
        <span className="navbar-divider" />
        {toolNav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`navbar-link${isActive(item.href) ? ' active' : ''}`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
