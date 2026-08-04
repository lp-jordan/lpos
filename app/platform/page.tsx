import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { listPasses } from '@/lib/store/platform-pass-store';
import { PlatformClient } from './PlatformClient';

export default async function PlatformPage() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) redirect('/signin');

  return <PlatformClient initialPasses={listPasses()} />;
}
