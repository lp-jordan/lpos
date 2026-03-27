import Link from 'next/link';

export default function SettingsPage() {
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
    </section>
  );
}
