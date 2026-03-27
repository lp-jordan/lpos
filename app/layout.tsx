import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import '@/app/globals.css';
import { AppShell } from '@/components/shell/AppShell';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById } from '@/lib/store/user-store';
import { toUserSummary } from '@/lib/store/user-store';

export const metadata: Metadata = {
  title: 'LPOS Dashboard',
  description: 'Project-first LPOS dashboard demo'
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const currentUser = toUserSummary(session ? getUserById(session.userId) : null);

  return (
    <html lang="en">
      <body>
        <AppShell currentUser={currentUser}>{children}</AppShell>
      </body>
    </html>
  );
}
