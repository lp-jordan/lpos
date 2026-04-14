'use client';

import { useState, useEffect } from 'react';

interface ReleaseStatus {
  watchDir:    string | null;
  version:     string | null;
  dmgFilename: string | null;
  lastUpdated: string | null;
}

export function LpReleasesCard() {
  const [status, setStatus]   = useState<ReleaseStatus | null>(null);
  const [watchDir, setWatchDir] = useState('');
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/lp-updates/config')
      .then((r) => r.json())
      .then((d: ReleaseStatus) => {
        setStatus(d);
        setWatchDir(d.watchDir ?? '');
      })
      .catch(() => setError('Could not load status'));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/lp-updates/config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ watchDir }),
      });
      const data = await res.json() as { ok?: boolean; status?: ReleaseStatus; error?: string };
      if (!res.ok) { setError(data.error ?? 'Save failed'); return; }
      if (data.status) setStatus(data.status);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch { setError('Network error'); }
    finally { setSaving(false); }
  }

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">LeaderPrompt Updates</h2>
        <p className="storage-settings-muted">
          Point LPOS at the folder where <code>electron-builder</code> writes its output.
          Run a build on this machine and LPOS will automatically serve the new version
          to connected LeaderPrompt clients.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
        <label style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
          Build output directory
          <input
            type="text"
            value={watchDir}
            onChange={(e) => setWatchDir(e.target.value)}
            placeholder="/Users/you/lp-app-ecosystem/leaderprompt/release"
            style={{
              display:     'block',
              width:       '100%',
              marginTop:   '0.4rem',
              padding:     '0.5rem 0.75rem',
              background:  'var(--surface-secondary, #0f1620)',
              border:      '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color:       'var(--color-text)',
              fontSize:    '0.85rem',
              fontFamily:  'monospace',
            }}
          />
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            className="storage-settings-primary"
            onClick={save}
            disabled={saving || !watchDir.trim()}
          >
            {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
          </button>
          {error && <span style={{ fontSize: '0.8rem', color: '#e57373' }}>{error}</span>}
        </div>
      </div>

      {status?.version && (
        <div style={{
          marginTop:   '1.25rem',
          padding:     '0.75rem 1rem',
          background:  'rgba(59,111,212,0.1)',
          border:      '1px solid rgba(59,111,212,0.25)',
          borderRadius: '8px',
          fontSize:    '0.85rem',
          color:       'var(--color-text-muted)',
        }}>
          Currently serving <strong style={{ color: 'var(--color-text)' }}>v{status.version}</strong>
          {status.lastUpdated && (
            <> &mdash; picked up {new Date(status.lastUpdated).toLocaleString()}</>
          )}
        </div>
      )}
    </div>
  );
}
