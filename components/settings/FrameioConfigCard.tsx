'use client';

import { useEffect, useState } from 'react';

/** Settings → Media: switch the automatic Frame.io upload on ingest on or off. */
export function FrameioConfigCard() {
  const [autoUpload, setAutoUpload] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/frameio-config', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { autoUpload: boolean }) => setAutoUpload(d.autoUpload))
      .catch(() => setError('Could not load Frame.io settings.'));
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/frameio-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoUpload: next }),
      });
      const data = await res.json() as { autoUpload?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save.');
      setAutoUpload(data.autoUpload ?? next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Frame.io</h2>
        <p className="storage-settings-muted">
          Automatically upload every new video to Frame.io on ingest. When off, new media goes
          straight to Cloudflare Stream and skips Frame.io. Files that are already on Frame.io are unaffected.
        </p>
      </div>
      {error && (
        <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.75rem', fontSize: '0.85rem' }}>{error}</p>
      )}
      {autoUpload === null && !error && <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>Loading…</p>}
      {autoUpload !== null && (
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1rem', fontSize: '0.85rem', cursor: saving ? 'default' : 'pointer' }}>
          <input
            type="checkbox"
            checked={autoUpload}
            disabled={saving}
            onChange={(e) => void toggle(e.target.checked)}
            style={{ accentColor: 'var(--color-primary, #3b82f6)' }}
          />
          Upload new media to Frame.io automatically
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted, #888)' }}>
            {saving ? 'Saving…' : autoUpload ? '— on' : '— off'}
          </span>
        </label>
      )}
    </div>
  );
}
