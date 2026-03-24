import type { Metadata } from 'next';
import '@/app/globals.css';
import { AppShell } from '@/components/shell/AppShell';

export const metadata: Metadata = {
  title: 'LPOS Dashboard',
  description: 'Project-first LPOS dashboard demo'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
