'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavBar } from '@/components/shell/NavBar';
import { Breadcrumb } from '@/components/shell/Breadcrumb';
import { TranscriptTray } from '@/components/shell/TranscriptTray';
import { UploadTray } from '@/components/shell/UploadTray';
import { IngestTray } from '@/components/shell/IngestTray';
import { ContextMenuProvider } from '@/contexts/ContextMenuContext';
import { ToastProvider } from '@/contexts/ToastContext';

function TrayGroup() {
  return (
    <div className="tray-group">
      <IngestTray />
      <UploadTray />
      <TranscriptTray />
    </div>
  );
}

function StorageGear() {
  return (
    <Link href="/settings/storage" className="storage-gear-link" aria-label="Storage settings" title="Storage settings">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
        <path d="M10.3 2.6h3.4l.6 2.5a7.9 7.9 0 0 1 1.8.7l2.2-1.3 2.4 2.4-1.3 2.2c.3.6.5 1.2.7 1.8l2.5.6v3.4l-2.5.6a7.9 7.9 0 0 1-.7 1.8l1.3 2.2-2.4 2.4-2.2-1.3c-.6.3-1.2.5-1.8.7l-.6 2.5h-3.4l-.6-2.5a7.9 7.9 0 0 1-1.8-.7l-2.2 1.3-2.4-2.4 1.3-2.2a7.9 7.9 0 0 1-.7-1.8l-2.5-.6v-3.4l2.5-.6a7.9 7.9 0 0 1 .7-1.8L3.8 7l2.4-2.4 2.2 1.3c.6-.3 1.2-.5 1.8-.7z" />
        <circle cx="12" cy="12" r="3.4" />
      </svg>
    </Link>
  );
}

export function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const isHome = pathname === '/';
  const isStudio = pathname.startsWith('/slate');

  if (isHome) {
    return (
      <ToastProvider>
        <ContextMenuProvider>
          <div className="app-home">
            {children}
            <StorageGear />
            {!isStudio && <TrayGroup />}
          </div>
        </ContextMenuProvider>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <ContextMenuProvider>
        <div className="app-inner">
          <NavBar />
          <Breadcrumb />
          <main className="app-content">
            {children}
          </main>
          <StorageGear />
          {!isStudio && <TrayGroup />}
        </div>
      </ContextMenuProvider>
    </ToastProvider>
  );
}
