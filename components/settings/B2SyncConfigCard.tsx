'use client';

import { useEffect, useState } from 'react';

interface B2SyncConfig {
  syncDirs:   string[];
  retainDays: number;
  syncHour:   number;
  updatedAt:  string;
}

interface ConfigResponse {
  config:          B2SyncConfig;
  credsConfigured: boolean;
}

function formatHour(h: number): string {
  const period = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${period}`;
}

export function B2SyncConfigCard() {
  const [config, setConfig]                 = useState<B2SyncConfig | null>(null);
  const [credsConfigured, setCredsOk]       = useState(true);
  const [dirsText, setDirsText]             = useState('');
  const [retainDays, setRetainDays]         = useState(30);
  const [syncHour, setSyncHour]             = useState(2);
  const [loading, setLoading]               = useState(true);
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [savedAt, setSavedAt]               = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/admin/b2-sync-config');
      if (!res.ok) throw new Error('Failed to load B2 sync configuration.');
      const data = await res.json() as ConfigResponse;
      setConfig(data.config);
      setCredsOk(data.credsConfigured);
      setDirsText(data.config.syncDirs.join('\n'));
      setRetainDays(data.config.retainDays);
      setSyncHour(data.config.syncHour);
    } catch {
      setError('Could not load B2 sync configuration.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const syncDirs = dirsText.split('\n').map((d) => d.trim()).filter(Boolean);
      const res = await fetch('/api/admin/b2-sync-config', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ syncDirs, retainDays, syncHour }),
      });
      const data = await res.json() as { config?: B2SyncConfig; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setConfig(data.config ?? null);
      if (data.config) {
        setDirsText(data.config.syncDirs.join('\n'));
        setRetainDays(data.config.retainDays);
        setSyncHour(data.config.syncHour);
      }
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="storage-settings-card">
      <h2 className="storage-settings-section-title">B2 Media Sync</h2>
      <p className="storage-settings-muted">
        Nightly upload of footage/media directories to Backblaze B2. Credentials live in Doppler;
        these knobs are tunable here and pick up live (~1 min) without a restart.
      </p>

      {!credsConfigured && (
        <p className="storage-settings-muted" style={{ color: '#ffb4ab', marginTop: 8 }}>
          B2 credentials (B2_MEDIA_ENDPOINT / KEY_ID / APPLICATION_KEY / BUCKET) are not set in
          Doppler — sync will stay idle until they are.
        </p>
      )}

      {loading && <p className="storage-settings-muted">Loading…</p>}
      {error && <p className="storage-settings-muted" style={{ color: '#ffb4ab' }}>{error}</p>}

      {!loading && config && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
          <div>
            <label htmlFor="b2-sync-dirs" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
              Source directories
            </label>
            <textarea
              id="b2-sync-dirs"
              value={dirsText}
              onChange={(e) => setDirsText(e.target.value)}
              rows={4}
              placeholder={`/Volumes/NAS/Projects\n/Volumes/NAS/Audio`}
              style={{
                width: '100%',
                fontFamily: 'monospace',
                fontSize: '0.9em',
                padding: 8,
                borderRadius: 8,
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'inherit',
              }}
            />
            <p className="storage-settings-muted" style={{ fontSize: '0.8em', marginTop: 4 }}>
              One absolute path per line. Empty = sync is idle.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div>
              <label htmlFor="b2-retain-days" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                Retention (days)
              </label>
              <input
                id="b2-retain-days"
                type="number"
                min={1}
                max={3650}
                value={retainDays}
                onChange={(e) => setRetainDays(Number(e.target.value))}
                style={{
                  width: 100,
                  padding: 6,
                  borderRadius: 6,
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'inherit',
                }}
              />
              <p className="storage-settings-muted" style={{ fontSize: '0.8em', marginTop: 4 }}>
                Objects older than this are swept after each run.
              </p>
            </div>

            <div>
              <label htmlFor="b2-sync-hour" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                Sync hour
              </label>
              <select
                id="b2-sync-hour"
                value={syncHour}
                onChange={(e) => setSyncHour(Number(e.target.value))}
                style={{
                  padding: 6,
                  borderRadius: 6,
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'inherit',
                }}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{formatHour(h)}</option>
                ))}
              </select>
              <p className="storage-settings-muted" style={{ fontSize: '0.8em', marginTop: 4 }}>
                Server local time. Runs once per day at this hour.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button
              type="button"
              className="storage-settings-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {savedAt && (
              <span className="storage-settings-muted" style={{ fontSize: '0.85em' }}>
                Saved at {savedAt} (last updated: {new Date(config.updatedAt).toLocaleString()})
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
