import Link from 'next/link';

// Only one top-level media page now — sub-pages (intake, library, collections,
// providers) have been removed in favour of the queue tray for status info.

export function MediaNav({ active }: Readonly<{ active: string }>) {
  return (
    <nav className="workflow-nav" aria-label="Media navigation">
      <Link href="/media" className={`workflow-link${active === '/media' || active === 'overview' ? ' active' : ''}`}>
        Overview
      </Link>
    </nav>
  );
}
