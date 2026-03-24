import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="home-hero">
<div className="home-brand">
        <h1 className="home-title">LPOS</h1>
        <p className="home-subtitle">LeaderPass Operating System</p>
      </div>

      <div className="home-tiles">
        <Link href="/projects" className="home-tile">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <span className="home-tile-label">Projects</span>
        </Link>
        <Link href="/media" className="home-tile">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          <span className="home-tile-label">Media</span>
        </Link>
      </div>

      <div className="home-divider" />

      <div className="home-tiles home-tiles--tools">
        <Link href="/slate" className="home-tile home-tile--tool">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <span className="home-tile-label">Studio</span>
        </Link>
      </div>
    </div>
  );
}
