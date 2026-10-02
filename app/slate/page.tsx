import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { STUDIO_PRESENTATION_ENABLED } from '@/lib/feature-flags';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { SlatePageContent } from '@/components/slate/SlatePageContent';

export default async function SlatePage({
  searchParams,
}: {
  searchParams: Promise<{ guest_access?: string }>;
}) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const isGuest   = session?.role === 'guest';
  const isAdmin   = session?.role === 'admin';
  const params    = await searchParams;
  const guestAccess = isGuest && params.guest_access === 'lighting' ? 'lighting' as const : undefined;
  // Plain guests are locked to the Presentation tab — with it parked there is
  // nothing for them here, so send them back to the guest home.
  if (isGuest && !guestAccess && !STUDIO_PRESENTATION_ENABLED) redirect('/guest');
  return <SlatePageContent isGuest={isGuest} isAdmin={isAdmin} guestAccess={guestAccess} />;
}
