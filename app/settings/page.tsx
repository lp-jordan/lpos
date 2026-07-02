import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { AdminSettings } from '@/components/settings/AdminSettings';

async function getRole() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  return session?.role ?? 'user';
}

export default async function SettingsPage() {
  const role = await getRole();
  return <AdminSettings role={role} />;
}
