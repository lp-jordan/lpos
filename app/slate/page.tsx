import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { SlatePageContent } from '@/components/slate/SlatePageContent';

export default async function SlatePage() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const isGuest = session?.role === 'guest';
  return <SlatePageContent isGuest={isGuest} />;
}
