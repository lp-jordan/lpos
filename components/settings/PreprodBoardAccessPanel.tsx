'use client';

import { useEffect, useState } from 'react';
import type { UserSummary } from '@/lib/models/user';

/**
 * Admin-only settings panel: list/grant/revoke the per-user permission to edit
 * Pre-Production board columns. Mirrors ProspectsAccessPanel exactly so the
 * Settings page stays visually consistent.
 */
export function PreprodBoardAccessPanel() {
  const [allUsers, setAllUsers]       = useState<UserSummary[]>([]);
  const [accessUsers, setAccessUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [selectedId, setSelectedId]   = useState('');
  const [granting, setGranting]       = useState(false);
  const [revoking, setRevoking]       = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const [usersRes, accessRes] = await Promise.all([
        fetch('/api/users'),
        fetch('/api/admin/preprod-board-admins'),
      ]);
      if (!usersRes.ok || !accessRes.ok) throw new Error('Failed to load data.');
      const usersData  = await usersRes.json()  as { users: UserSummary[] };
      const accessData = await accessRes.json() as { users: UserSummary[] };
      setAllUsers(usersData.users.filter((u) => !u.isGuest));
      setAccessUsers(accessData.users);
    } catch {
      setError('Could not load Pre-Production board admin list. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const accessIds     = new Set(accessUsers.map((u) => u.id));
  const eligibleUsers = allUsers.filter((u) => !accessIds.has(u.id));

  async function handleGrant() {
    if (!selectedId) return;
    setGranting(true);
    setActionError(null);
    try {
      const res  = await fetch('/api/admin/preprod-board-admins', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId: selectedId }),
      });
      const data = await res.json() as { users?: UserSummary[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to grant access.');
      setAccessUsers(data.users ?? []);
      setSelectedId('');
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setGranting(false);
    }
  }

  async function handleRevoke(userId: string) {
    setRevoking(userId);
    setActionError(null);
    try {
      const res  = await fetch('/api/admin/preprod-board-admins', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId }),
      });
      const data = await res.json() as { users?: UserSummary[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to revoke access.');
      setAccessUsers(data.users ?? []);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Pre-Production Board Admins</h2>
        <p className="storage-settings-muted">
          Users listed here can add, rename, recolor, reorder, and delete columns on the
          Pre-Production task board (the first tab on the dashboard). Real admins always have
          this permission — this list extends it to specific non-admin operators.
        </p>
      </div>

      {loading && <p className="storage-settings-muted">Loading…</p>}
      {error   && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.5rem' }}>{error}</p>}

      {!loading && (
        <>
          <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0' }}>
            {accessUsers.length === 0 && (
              <li style={{ fontSize: '0.875rem', opacity: 0.5, padding: '0.4rem 0' }}>
                No non-admin users have been granted this permission yet.
              </li>
            )}
            {accessUsers.map((user) => (
              <li
                key={user.id}
                style={{
                  display:        'flex',
                  alignItems:     'center',
                  justifyContent: 'space-between',
                  padding:        '0.4rem 0',
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
                  onClick={() => handleRevoke(user.id)}
                  disabled={revoking === user.id}
                  style={{
                    background: 'none',
                    border:     'none',
                    cursor:     revoking === user.id ? 'default' : 'pointer',
                    color:      'var(--color-error, #e55)',
                    fontSize:   '0.8rem',
                    opacity:    revoking === user.id ? 0.4 : 1,
                    padding:    '0 0.25rem',
                  }}
                >
                  {revoking === user.id ? 'Removing…' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
            <select
              value={selectedId}
              onChange={(e) => { setSelectedId(e.target.value); setActionError(null); }}
              disabled={granting || eligibleUsers.length === 0}
              style={{
                flex:         1,
                padding:      '0.45rem 0.75rem',
                borderRadius: '6px',
                border:       '1px solid var(--color-border, #444)',
                background:   'var(--color-input-bg, #1a1a1a)',
                color:        'inherit',
                fontSize:     '0.875rem',
              }}
            >
              <option value="">
                {eligibleUsers.length === 0 ? 'All eligible users already granted' : 'Select a user…'}
              </option>
              {eligibleUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {u.email}
                </option>
              ))}
            </select>
            <button
              onClick={handleGrant}
              disabled={granting || !selectedId}
              className="storage-settings-primary"
              style={{ whiteSpace: 'nowrap' }}
            >
              {granting ? 'Granting…' : 'Grant Access'}
            </button>
          </div>

          {actionError && (
            <p style={{ color: 'var(--color-error, #e55)', fontSize: '0.8rem', marginTop: '0.4rem' }}>
              {actionError}
            </p>
          )}
        </>
      )}
    </div>
  );
}
