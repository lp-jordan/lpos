'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { NavBar } from '@/components/shell/NavBar';
import { Breadcrumb } from '@/components/shell/Breadcrumb';
import { PipelineTray } from '@/components/shell/PipelineTray';
import { UserMenu } from '@/components/shell/UserMenu';
import { NotifBell } from '@/components/shell/NotifBell';
import { WishListButton } from '@/components/shell/WishListButton';
import { VersionTag } from '@/components/shell/VersionTag';
import { ContextMenuProvider } from '@/contexts/ContextMenuContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { VersionConfirmProvider } from '@/contexts/VersionConfirmContext';
import { RestartCountdownBanner } from '@/components/shell/RestartCountdownBanner';
import { PresenceReporter } from '@/components/PresenceReporter';
import type { UserSummary } from '@/lib/models/user';
import type { AppVersion } from '@/lib/version';

function TrayGroup({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="tray-group">
      <PipelineTray isAdmin={isAdmin} />
    </div>
  );
}

function GuestSignOutButton() {
  return (
    <form action="/api/auth/logout" method="post">
      <button type="submit" className="guest-signout-btn" data-guest-ok>
        Sign out
      </button>
    </form>
  );
}

function StorageGear({ home = false }: { home?: boolean }) {
  return (
    <Link
      href="/settings"
      className={`storage-gear-link${home ? ' storage-gear-link--home' : ''}`}
      aria-label="Storage settings"
      title="Storage settings"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
        <path d="M10.3 2.6h3.4l.6 2.5a7.9 7.9 0 0 1 1.8.7l2.2-1.3 2.4 2.4-1.3 2.2c.3.6.5 1.2.7 1.8l2.5.6v3.4l-2.5.6a7.9 7.9 0 0 1-.7 1.8l1.3 2.2-2.4 2.4-2.2-1.3c-.6.3-1.2.5-1.8.7l-.6 2.5h-3.4l-.6-2.5a7.9 7.9 0 0 1-1.8-.7l-2.2 1.3-2.4-2.4 1.3-2.2a7.9 7.9 0 0 1-.7-1.8l-2.5-.6v-3.4l2.5-.6a7.9 7.9 0 0 1 .7-1.8L3.8 7l2.4-2.4 2.2 1.3c.6-.3 1.2-.5 1.8-.7z" />
        <circle cx="12" cy="12" r="3.4" />
      </svg>
    </Link>
  );
}

function EditpanelButton({ home = false }: { home?: boolean }) {
  return (
    <Link
      href="/ep-update"
      className={`editpanel-dl-btn${home ? ' editpanel-dl-btn--home' : ''}`}
      aria-label="Download EditPanel"
      title="EditPanel — download the latest build"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18" />
        <path d="M9 9v11" />
      </svg>
    </Link>
  );
}

export function AppShell({
  children,
  currentUser,
  hasProspects = false,
  epDownload = false,
  isAdmin = false,
  version,
}: Readonly<{
  children: React.ReactNode;
  currentUser: UserSummary | null;
  hasProspects?: boolean;
  epDownload?: boolean;
  isAdmin?: boolean;
  version: AppVersion;
}>) {
  const pathname = usePathname();
  const router = useRouter();
  const isHome = pathname === '/';
  const isStudio = pathname.startsWith('/slate');
  const isSignIn = pathname === '/signin';
  const isInternalReview = pathname.startsWith('/internal-review');

  const isGuest = currentUser?.isGuest ?? false;

  // Internal Review is a focused, full-bleed black/gold environment: no NavBar
  // or breadcrumb (the /internal-review crumb is a dead link), just a small
  // back + home control floating over the review.
  if (isInternalReview) {
    return (
      <ToastProvider>
        <ContextMenuProvider>
          <VersionConfirmProvider>
            <div className="app-internal-review" data-guest={isGuest || undefined}>
              <PresenceReporter />
              <RestartCountdownBanner />
              <nav className="ir-nav" aria-label="Internal review navigation">
                <button
                  type="button"
                  className="ir-nav-btn"
                  onClick={() => router.back()}
                  aria-label="Go back"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="15 18 9 12 15 6"/>
                  </svg>
                </button>
                <Link href="/" className="ir-nav-btn" aria-label="Home">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
                  </svg>
                </Link>
              </nav>
              {children}
            </div>
          </VersionConfirmProvider>
        </ContextMenuProvider>
      </ToastProvider>
    );
  }

  if (isHome) {
    return (
      <ToastProvider>
        <ContextMenuProvider>
          <VersionConfirmProvider>
            <div className="app-home" data-guest={isGuest || undefined}>
              <PresenceReporter />
              <RestartCountdownBanner />
              <VersionTag version={version} />
              {children}
              {currentUser && !isGuest && <NotifBell />}
              {currentUser && !isGuest && <UserMenu user={currentUser} />}
              {currentUser && !isGuest && <WishListButton currentUser={currentUser} home />}
              {currentUser && !isGuest && epDownload && <EditpanelButton home />}
              {isGuest && <GuestSignOutButton />}
              {!isGuest && <StorageGear home />}
              {!isGuest && <TrayGroup isAdmin={isAdmin} />}
            </div>
          </VersionConfirmProvider>
        </ContextMenuProvider>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
        <ContextMenuProvider>
          <VersionConfirmProvider>
            <div className="app-inner" data-guest={isGuest || undefined}>
              <PresenceReporter />
              <RestartCountdownBanner />
              <VersionTag version={version} />
              {currentUser && !isSignIn && !isGuest && <NotifBell />}
              {currentUser && !isSignIn && !isGuest && <UserMenu user={currentUser} />}
              {isGuest && <GuestSignOutButton />}
              <NavBar hasProspects={hasProspects} />
              <Breadcrumb />
            <main className={`app-content${pathname === '/dashboard' ? ' app-content--wide' : ''}`}>
              {children}
            </main>
            {currentUser && !isSignIn && !isGuest && <WishListButton currentUser={currentUser} />}
            {!isGuest && <StorageGear />}
            {!isGuest && !isStudio && <TrayGroup isAdmin={isAdmin} />}
          </div>
        </VersionConfirmProvider>
      </ContextMenuProvider>
    </ToastProvider>
  );
}
