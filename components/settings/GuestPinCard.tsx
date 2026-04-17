import { getTodayPin } from '@/lib/services/guest-pin';

const GUEST_PIN_URL = `${process.env.APP_LOCAL_URL ?? 'http://localhost:3000'}/guest-pin`;

export function GuestPinCard() {
  const pin = getTodayPin();

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Guest Access PIN</h2>
        <p className="storage-settings-muted">
          Today&apos;s 4-digit PIN for local network guest login. Share this with clients who need
          to connect from the studio device. Resets automatically at midnight UTC.
        </p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', marginTop: '1rem' }}>
        <span
          style={{
            fontFamily: 'monospace',
            fontSize: '2.5rem',
            fontWeight: 700,
            letterSpacing: '0.4em',
            color: 'var(--color-text, #fff)',
          }}
        >
          {pin}
        </span>
        <p style={{ fontSize: '0.8rem', color: 'var(--color-text-muted, #888)', margin: 0 }}>
          Valid today only
          <br />
          (<code>{GUEST_PIN_URL}</code>)
        </p>
      </div>
    </div>
  );
}
