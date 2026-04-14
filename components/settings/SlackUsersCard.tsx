'use client';

import { useCallback, useEffect, useState } from 'react';

interface SlackUser {
  id: string;
  name: string;
  email: string;
  slackEmail: string | null;
}

export function SlackUsersCard() {
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/slack-emails');
      if (!res.ok) throw new Error('Failed to load users.');
      const data = await res.json() as { users: SlackUser[] };
      setUsers(data.users);
      const initialDrafts: Record<string, string> = {};
      for (const u of data.users) initialDrafts[u.id] = u.slackEmail ?? '';
      setDrafts(initialDrafts);
    } catch {
      setError('Could not load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleSave(userId: string) {
    setSaving(userId);
    setSaved(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/slack-emails/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slackEmail: drafts[userId] || null }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; slackEmail?: string | null };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save.');
      setUsers((prev) =>
        prev.map((u) => u.id === userId ? { ...u, slackEmail: data.slackEmail ?? null } : u),
      );
      setSaved(userId);
      setTimeout(() => setSaved((v) => (v === userId ? null : v)), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Slack Email Overrides</h2>
        <p className="storage-settings-muted">
          If a team member&apos;s Slack email differs from their LPOS login, set it here.
          Leave blank to use their LPOS email.
        </p>
      </div>

      {loading && <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>Loading…</p>}
      {error && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.75rem', fontSize: '0.85rem' }}>{error}</p>}

      {!loading && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {users.map((u) => (
            <li
              key={u.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr auto',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.5rem 0.75rem',
                background: 'var(--color-surface-raised, #222)',
                borderRadius: '6px',
                fontSize: '0.875rem',
              }}
            >
              <div>
                <span style={{ fontWeight: 600, color: 'var(--color-text, #fff)' }}>{u.name}</span>
                <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--color-text-muted, #888)' }}>
                  {u.email}
                </span>
              </div>
              <input
                type="email"
                placeholder="Slack email override…"
                value={drafts[u.id] ?? ''}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [u.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(u.id); }}
                disabled={saving === u.id}
                style={{
                  padding: '0.35rem 0.6rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border, #444)',
                  background: 'var(--color-input-bg, #1a1a1a)',
                  color: 'inherit',
                  fontSize: '0.85rem',
                  width: '100%',
                }}
              />
              <button
                onClick={() => void handleSave(u.id)}
                disabled={saving === u.id || drafts[u.id] === (u.slackEmail ?? '')}
                style={{
                  padding: '0.35rem 0.85rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border, #444)',
                  background: saved === u.id ? 'var(--color-success-bg, #1a3a1a)' : 'var(--color-surface, #333)',
                  color: saved === u.id ? 'var(--color-success, #4caf50)' : 'var(--color-text, #fff)',
                  fontSize: '0.8rem',
                  cursor: saving === u.id || drafts[u.id] === (u.slackEmail ?? '') ? 'default' : 'pointer',
                  opacity: saving === u.id || drafts[u.id] === (u.slackEmail ?? '') ? 0.4 : 1,
                  whiteSpace: 'nowrap',
                  transition: 'background 0.2s, color 0.2s',
                }}
              >
                {saving === u.id ? 'Saving…' : saved === u.id ? 'Saved' : 'Save'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
