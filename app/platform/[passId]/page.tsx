import { redirect, notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getPass, getPassBySlug } from '@/lib/store/platform-pass-store';
import { PassWorkspace } from '../PassWorkspace';

export default async function PassPage({ params }: { params: Promise<{ passId: string }> }) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) redirect('/signin');

  const { passId } = await params; // id or slug
  if (!getPass(passId) && !getPassBySlug(passId)) notFound();

  return <PassWorkspace passIdOrSlug={passId} />;
}
