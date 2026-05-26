import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getUserById } from '@/lib/store/user-store';

const CALLBACK_SCHEME = 'lpos-editpanel://';
const MAX_MACHINE_LEN = 80;

export default async function EpLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const machine = strOrNull(params.machine)?.slice(0, MAX_MACHINE_LEN) ?? '';
  const callback = strOrNull(params.callback) ?? '';

  // Strict callback validation — only the registered Electron URL scheme is allowed
  // (prevents anyone from sending a victim here with ?callback=https://attacker.com).
  if (!callback.startsWith(CALLBACK_SCHEME)) {
    return (
      <div className="signin-shell">
        <div className="utility-page-card">
          <div className="utility-page-kicker">EditPanel link</div>
          <h1 className="utility-page-title">Invalid request</h1>
          <p className="utility-page-copy">
            This sign-in link is missing or has an unrecognised callback target. Open EditPanel and click
            Sign in to LPOS from there.
          </p>
        </div>
      </div>
    );
  }

  // Require an LPOS session; round-trip through Google if absent.
  const session = await verifySessionToken((await cookies()).get(APP_SESSION_COOKIE)?.value);
  const user = session ? getUserById(session.userId) : null;
  if (!session || !user) {
    const here = `/ep/link?machine=${encodeURIComponent(machine)}&callback=${encodeURIComponent(callback)}`;
    redirect(`/api/auth/google/connect?return_to=${encodeURIComponent(here)}`);
  }

  const displayMachine = machine || 'an unnamed machine';

  return (
    <div className="signin-shell">
      <div className="utility-page-card">
        <div className="utility-page-kicker">EditPanel link</div>
        <h1 className="utility-page-title">Approve this machine?</h1>
        <p className="utility-page-copy">
          EditPanel on <strong>{displayMachine}</strong> is asking to connect to your LPOS account
          as <strong>{user.name}</strong> ({user.email}).
        </p>
        <p className="utility-page-copy" style={{ marginTop: 12, fontSize: '0.85rem', opacity: 0.7 }}>
          Approving creates a long-lived access token for this machine. You can revoke it any time
          from LPOS Settings → Connected EditPanel devices.
        </p>

        <form method="POST" action="/api/ep/link/respond" style={{ marginTop: 20 }}>
          <input type="hidden" name="machine" value={machine} />
          <input type="hidden" name="callback" value={callback} />

          <button
            type="submit"
            name="action"
            value="approve"
            className="signin-google-button"
            style={{ background: 'rgba(219, 175, 95, 0.96)' }}
          >
            Approve EditPanel
          </button>

          <button
            type="submit"
            name="action"
            value="deny"
            className="signin-guest-button"
          >
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
}

function strOrNull(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}
