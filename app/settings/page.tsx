import Link from 'next/link';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { AdminsPanel } from '@/components/settings/AdminsPanel';
import { GuestPinCard } from '@/components/settings/GuestPinCard';

async function getRole() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  return session?.role ?? 'user';
}

export default async function SettingsPage() {
  const role = await getRole();

  return (
    <section className="storage-settings-page">
      <div className="storage-settings-hero">
        <div>
          <p className="storage-settings-kicker">Settings</p>
          <h1 className="storage-settings-title">Host settings</h1>
          <p className="storage-settings-copy">
            Manage the LPOS host configuration for storage and other machine-level controls.
          </p>
        </div>
      </div>

      <div className="storage-settings-card settings-link-card">
        <div>
          <h2 className="storage-settings-section-title">Storage</h2>
          <p className="storage-settings-muted">
            Choose which attached drives LPOS should use for managed media storage and failover.
          </p>
        </div>
        <Link href="/settings/storage" className="storage-settings-primary settings-link-button">
          Open Storage Settings
        </Link>
      </div>

      {role === 'admin' && (
        <div className="storage-settings-card settings-link-card">
          <div>
            <h2 className="storage-settings-section-title">Google Drive</h2>
            <p className="storage-settings-muted">
              Configure the Shared Drive integration — connection status, folder setup, and backfill.
            </p>
          </div>
          <Link href="/settings/drive" className="storage-settings-primary settings-link-button">
            Open Drive Settings
          </Link>
        </div>
      )}

      {role === 'admin' && <GuestPinCard />}
      {role === 'admin' && <AdminsPanel />}
    </section>
  );
}
