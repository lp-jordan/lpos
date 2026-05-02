import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import '@/app/globals.css';
import { AppShell } from '@/components/shell/AppShell';
import { ServiceWorkerRegistrar } from '@/components/shell/ServiceWorkerRegistrar';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById, toUserSummary } from '@/lib/store/user-store';
import { hasProspectsAccess } from '@/lib/store/prospect-access-store';

export const metadata: Metadata = {
  title: 'LPOS Dashboard',
  description: 'Project-first LPOS dashboard demo'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover'
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const currentUser   = toUserSummary(session ? getUserById(session.userId) : null);
  const hasProspects  = session
    ? hasProspectsAccess(session.userId, session.role === 'admin')
    : false;

  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegistrar />
        <AppShell currentUser={currentUser} hasProspects={hasProspects}>{children}</AppShell>
      </body>
    </html>
  );
}
