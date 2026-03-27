import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { APP_SESSION_COOKIE, createSessionToken, getSessionCookieOptions } from '@/lib/services/session-auth';
import { getOrCreateGuestUser } from '@/lib/store/user-store';

export async function GET() {
  const guest = getOrCreateGuestUser();
  const token = await createSessionToken(guest.id);
  const cookieStore = await cookies();
  cookieStore.set(APP_SESSION_COOKIE, token, getSessionCookieOptions());
  redirect('/');
}
