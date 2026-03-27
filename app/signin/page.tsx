import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById } from '@/lib/store/user-store';

const ERROR_COPY: Record<string, string> = {
  config: 'Google sign-in is not configured yet. Add the Google client ID and client secret to continue.',
  state: 'The Google sign-in handshake expired or could not be verified. Please try again.',
  token: 'Google sign-in completed, but LPOS could not finish the token exchange.',
  profile: 'LPOS could not read the Google profile needed to create your session.',
};

export default async function SignInPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get(APP_SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (session && getUserById(session.userId)) {
    redirect('/');
  }

  const searchParams = await props.searchParams;
  const errorParam = searchParams?.error;
  const error = Array.isArray(errorParam) ? errorParam[0] : errorParam;
  const message = error ? ERROR_COPY[error] ?? 'Sign-in could not be completed.' : null;

  return (
    <div className="signin-shell">
      <div className="signin-card">
        <div className="signin-kicker">Sign In</div>
        <h1 className="signin-title">LPOS</h1>
        <p className="signin-copy">LeaderPass Operating System</p>

        {message && <div className="signin-error">{message}</div>}

        <a href="/api/auth/google/connect" className="signin-google-button">
          <span className="signin-google-mark" aria-hidden="true">G</span>
          <span>Continue with Google</span>
        </a>

        <a href="/api/auth/guest" className="signin-guest-button">
          Continue as Guest
        </a>
      </div>
    </div>
  );
}
