'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavBar } from '@/components/shell/NavBar';
import { Breadcrumb } from '@/components/shell/Breadcrumb';
import { PipelineTray } from '@/components/shell/PipelineTray';
import { UserMenu } from '@/components/shell/UserMenu';
import { NotifBell } from '@/components/shell/NotifBell';
import { WishListButton } from '@/components/shell/WishListButton';
import { ContextMenuProvider } from '@/contexts/ContextMenuContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { VersionConfirmProvider } from '@/contexts/VersionConfirmContext';
import { RestartCountdownBanner } from '@/components/shell/RestartCountdownBanner';
import { PresenceReporter } from '@/components/PresenceReporter';
import type { UserSummary } from '@/lib/models/user';

function TrayGroup() {
  return (
    <div className="tray-group">
      <PipelineTray />
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

export function AppShell({
  children,
  currentUser,
}: Readonly<{ children: React.ReactNode; currentUser: UserSummary | null }>) {
  const pathname = usePathname();
  const isHome = pathname === '/';
  const isStudio = pathname.startsWith('/slate');
  const isSignIn = pathname === '/signin';

  const isGuest = currentUser?.isGuest ?? false;

  if (isHome) {
    return (
      <ToastProvider>
        <ContextMenuProvider>
          <VersionConfirmProvider>
            <div className="app-home" data-guest={isGuest || undefined}>
              <PresenceReporter />
              <RestartCountdownBanner />
              {children}
              {currentUser && !isGuest && <NotifBell />}
              {currentUser && !isGuest && <UserMenu user={currentUser} />}
              {currentUser && !isGuest && <WishListButton currentUser={currentUser} home />}
              {isGuest && <GuestSignOutButton />}
              {!isGuest && <StorageGear home />}
              {!isGuest && <TrayGroup />}
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
              {currentUser && !isSignIn && !isGuest && <NotifBell />}
              {currentUser && !isSignIn && !isGuest && <UserMenu user={currentUser} />}
              {isGuest && <GuestSignOutButton />}
              <NavBar />
              <Breadcrumb />
            <main className={`app-content${pathname === '/dashboard' ? ' app-content--wide' : ''}`}>
              {children}
            </main>
            {currentUser && !isSignIn && !isGuest && <WishListButton currentUser={currentUser} />}
            {!isGuest && <StorageGear />}
            {!isGuest && !isStudio && <TrayGroup />}
          </div>
        </VersionConfirmProvider>
      </ContextMenuProvider>
    </ToastProvider>
  );
}
