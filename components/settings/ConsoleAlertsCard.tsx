'use client';

import { useCallback, useEffect, useState } from 'react';

interface AlertUser {
  id: string;
  name: string;
  email: string;
  slackEmail: string | null;
  enabled: boolean;
}

export function ConsoleAlertsCard() {
  const [users, setUsers] = useState<AlertUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/console-alerts');
      if (!res.ok) throw new Error('Failed to load users.');
      const data = await res.json() as { users: AlertUser[] };
      setUsers(data.users);
    } catch {
      setError('Could not load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function toggle(userId: string) {
    setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, enabled: !u.enabled } : u));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const recipientUserIds = users.filter((u) => u.enabled).map((u) => u.id);
      const res = await fetch('/api/admin/console-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientUserIds }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save.');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const enabledCount = users.filter((u) => u.enabled).length;

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Console Alert Recipients</h2>
        <p className="storage-settings-muted">
          Selected users receive a Slack DM when the server crashes, enters a crash loop, or recovers.
          Uses each user&apos;s Slack email — configure overrides in Slack Email Overrides below.
        </p>
      </div>

      {loading && <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>Loading…</p>}
      {error && (
        <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.75rem', fontSize: '0.85rem' }}>
          {error}
        </p>
      )}

      {!loading && (
        <>
          <ul style={{
            listStyle: 'none', padding: 0, margin: '1rem 0 0',
            display: 'flex', flexDirection: 'column', gap: '0.5rem',
          }}>
            {users.map((u) => (
              <li
                key={u.id}
                onClick={() => toggle(u.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.5rem 0.75rem',
                  background: u.enabled ? 'var(--color-surface-raised, #222)' : 'transparent',
                  border: `1px solid ${u.enabled ? 'var(--color-border-active, #555)' : 'var(--color-border, #333)'}`,
                  borderRadius: '6px',
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                  userSelect: 'none',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                <input
                  type="checkbox"
                  checked={u.enabled}
                  onChange={() => toggle(u.id)}
                  style={{ accentColor: 'var(--color-primary, #3b82f6)', flexShrink: 0 }}
                  onClick={(e) => e.stopPropagation()}
                />
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600, color: 'var(--color-text, #fff)' }}>{u.name}</span>
                  <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--color-text-muted, #888)' }}>
                    {u.slackEmail ?? u.email}
                  </span>
                </div>
                {u.enabled && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--color-success, #4caf50)', fontWeight: 500 }}>
                    Alerts on
                  </span>
                )}
              </li>
            ))}
          </ul>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem' }}>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                padding: '0.4rem 1rem',
                borderRadius: '6px',
                border: '1px solid var(--color-border, #444)',
                background: saved ? 'var(--color-success-bg, #1a3a1a)' : 'var(--color-surface, #333)',
                color: saved ? 'var(--color-success, #4caf50)' : 'var(--color-text, #fff)',
                fontSize: '0.85rem',
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.5 : 1,
                transition: 'background 0.2s, color 0.2s',
                fontWeight: 500,
              }}
            >
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </button>
            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted, #888)' }}>
              {enabledCount === 0
                ? 'No recipients — alerts disabled'
                : `${enabledCount} recipient${enabledCount === 1 ? '' : 's'} enabled`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
