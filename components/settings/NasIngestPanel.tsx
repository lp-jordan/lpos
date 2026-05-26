'use client';

import { useEffect, useState } from 'react';
import type { UserSummary } from '@/lib/models/user';

export function NasIngestPanel() {
  const [users, setUsers]       = useState<UserSummary[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/users');
      if (!res.ok) throw new Error('Failed to load users.');
      const data = await res.json() as { users: UserSummary[] };
      setUsers(data.users.filter((u) => !u.isGuest));
    } catch {
      setError('Could not load users. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function handleToggle(user: UserSummary) {
    setToggling(user.id);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/nas-ingest`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !user.nasIngestAccess }),
      });
      const data = await res.json() as { user?: UserSummary; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to update access.');
      if (data.user) {
        setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, nasIngestAccess: data.user!.nasIngestAccess } : u));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">NAS Ingest Access</h2>
        <p className="storage-settings-muted">
          Users with access can right-click the upload zone in any project to toggle NAS ingest mode,
          which registers files directly from the NAS without uploading through the browser.
        </p>
      </div>

      {loading && <p className="storage-settings-muted">Loading…</p>}
      {error   && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.5rem' }}>{error}</p>}

      {!loading && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0' }}>
          {users.length === 0 && (
            <li style={{ fontSize: '0.875rem', opacity: 0.5, padding: '0.4rem 0' }}>No users found.</li>
          )}
          {users.map((user) => (
            <li
              key={user.id}
              style={{
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'space-between',
                padding:        '0.5rem 0',
                borderBottom:   '1px solid var(--color-border, #333)',
              }}
            >
              <span style={{ fontSize: '0.9rem' }}>
                {user.name}
                <span style={{ marginLeft: '0.5rem', opacity: 0.5, fontSize: '0.8rem' }}>
                  {user.email}
                </span>
              </span>
              <button
                onClick={() => handleToggle(user)}
                disabled={toggling === user.id}
                style={{
                  background:   user.nasIngestAccess ? 'var(--color-accent, #4a9eff)' : 'var(--color-input-bg, #1a1a1a)',
                  border:       '1px solid var(--color-border, #444)',
                  borderRadius: '4px',
                  cursor:       toggling === user.id ? 'default' : 'pointer',
                  color:        user.nasIngestAccess ? '#fff' : 'inherit',
                  fontSize:     '0.8rem',
                  opacity:      toggling === user.id ? 0.5 : 1,
                  padding:      '0.25rem 0.6rem',
                  minWidth:     '72px',
                  transition:   'background 0.15s',
                }}
              >
                {toggling === user.id ? '…' : user.nasIngestAccess ? 'Enabled' : 'Disabled'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
