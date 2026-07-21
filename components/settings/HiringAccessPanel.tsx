'use client';

import { useEffect, useState } from 'react';
import type { UserSummary } from '@/lib/models/user';

/**
 * Mirrors ProspectsAccessPanel with two deliberate differences:
 *
 *  - The grant dropdown is populated ONLY from users who already hold People
 *    access, because hiring access nests underneath it. The server supplies
 *    that list rather than the panel filtering all users.
 *  - The copy says admins are NOT automatically included, because that is the
 *    opposite of every other access panel in Settings.
 */
export function HiringAccessPanel() {
  const [accessUsers, setAccessUsers] = useState<UserSummary[]>([]);
  const [eligible, setEligible]       = useState<UserSummary[]>([]);
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
      const res = await fetch('/api/admin/hiring-access');
      if (!res.ok) throw new Error('Failed to load data.');
      const data = await res.json() as { users: UserSummary[]; eligible: UserSummary[] };
      setAccessUsers(data.users);
      setEligible(data.eligible);
    } catch {
      setError('Could not load Hiring access list. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function handleGrant() {
    if (!selectedId) return;
    setGranting(true);
    setActionError(null);
    try {
      const res  = await fetch('/api/admin/hiring-access', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId: selectedId }),
      });
      const data = await res.json() as { users?: UserSummary[]; eligible?: UserSummary[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to grant access.');
      setAccessUsers(data.users ?? []);
      setEligible(data.eligible ?? []);
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
      const res  = await fetch('/api/admin/hiring-access', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId }),
      });
      const data = await res.json() as { users?: UserSummary[]; eligible?: UserSummary[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to revoke access.');
      setAccessUsers(data.users ?? []);
      setEligible(data.eligible ?? []);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="storage-settings-card" style={{ borderLeft: '2px solid var(--line-strong, #444)' }}>
      <div>
        <h2 className="storage-settings-section-title">Hiring Access</h2>
        <p className="storage-settings-muted">
          Users listed here can see the Hiring tab on People, create candidate assessment links, and
          read completed candidate reports. This sits <strong>underneath</strong> Prospects access —
          only users who already have it can be granted Hiring, and revoking Prospects removes
          Hiring too. Unlike other permissions, <strong>admins are not included automatically</strong>;
          grant it explicitly, including to yourself.
        </p>
      </div>

      {loading && <p className="storage-settings-muted">Loading…</p>}
      {error   && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.5rem' }}>{error}</p>}

      {!loading && (
        <>
          <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0' }}>
            {accessUsers.length === 0 && (
              <li style={{ fontSize: '0.875rem', opacity: 0.5, padding: '0.4rem 0' }}>
                No users have been granted access yet.
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
              disabled={granting || eligible.length === 0}
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
                {eligible.length === 0
                  ? 'No eligible users — grant Prospects access first'
                  : 'Select a user…'}
              </option>
              {eligible.map((u) => (
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
