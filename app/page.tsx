import Link from 'next/link';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { hasProspectsAccess } from '@/lib/store/prospect-access-store';
import { WhatsNewWidget } from '@/components/home/WhatsNewWidget';

export default async function HomePage() {
  const cookieStore = await cookies();
  const session     = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const showProspects = session
    ? hasProspectsAccess(session.userId, session.role === 'admin')
    : false;

  return (
    <div className="home-hero">
      <div className="home-brand">
        <span className="home-title-wrap">
          <h1 className="home-title">LPOS</h1>
          <WhatsNewWidget />
        </span>
        <p className="home-subtitle">LeaderPass Operating System</p>
      </div>

      <div className="home-tiles">
        {showProspects && (
          <Link href="/people" className="home-tile">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <span className="home-tile-label">People</span>
          </Link>
        )}
        <Link href="/projects" className="home-tile">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <span className="home-tile-label">Projects</span>
        </Link>
        <Link href="/platform" className="home-tile">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="2" y1="20" x2="22" y2="20" />
            <line x1="6" y1="20" x2="6" y2="17" />
            <line x1="18" y1="20" x2="18" y2="17" />
          </svg>
          <span className="home-tile-label">Platform</span>
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
