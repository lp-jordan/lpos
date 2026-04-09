'use client';

import { useEffect, useRef, useState } from 'react';

interface AdminsResponse {
  admins: string[];
  bootstrapAdmin: string;
}

export function AdminsPanel() {
  const [admins, setAdmins]               = useState<string[]>([]);
  const [bootstrapAdmin, setBootstrapAdmin] = useState('');
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);
  const [inputEmail, setInputEmail]       = useState('');
  const [adding, setAdding]               = useState(false);
  const [addError, setAddError]           = useState<string | null>(null);
  const [removing, setRemoving]           = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/admin/admins');
      if (!res.ok) throw new Error('Failed to load admin list.');
      const data = await res.json() as AdminsResponse;
      setAdmins(data.admins);
      setBootstrapAdmin(data.bootstrapAdmin);
    } catch {
      setError('Could not load admin list. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function handleAdd() {
    const email = inputEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setAddError('Enter a valid email address.');
      inputRef.current?.focus();
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch('/api/admin/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json() as { admins?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to add admin.');
      setAdmins(data.admins ?? []);
      setInputEmail('');
    } catch (err) {
      setAddError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(email: string) {
    setRemoving(email);
    try {
      const res = await fetch('/api/admin/admins', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json() as { admins?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to remove admin.');
      setAdmins(data.admins ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Admins</h2>
        <p className="storage-settings-muted">
          Admin accounts have full access to LPOS, including server controls and configuration.
          The primary admin cannot be removed.
        </p>
      </div>

      {loading && <p className="storage-settings-muted">Loading…</p>}
      {error && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.5rem' }}>{error}</p>}

      {!loading && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0' }}>
          {admins.map((email) => (
            <li
              key={email}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.4rem 0',
                borderBottom: '1px solid var(--color-border, #333)',
              }}
            >
              <span style={{ fontSize: '0.9rem' }}>
                {email}
                {email === bootstrapAdmin && (
                  <span
                    style={{
                      marginLeft: '0.5rem',
                      fontSize: '0.75rem',
                      opacity: 0.5,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    primary
                  </span>
                )}
              </span>
              {email !== bootstrapAdmin && (
                <button
                  onClick={() => handleRemove(email)}
                  disabled={removing === email}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: removing === email ? 'default' : 'pointer',
                    color: 'var(--color-error, #e55)',
                    fontSize: '0.8rem',
                    opacity: removing === email ? 0.4 : 1,
                    padding: '0 0.25rem',
                  }}
                >
                  {removing === email ? 'Removing…' : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
        <input
          ref={inputRef}
          type="email"
          placeholder="email@example.com"
          value={inputEmail}
          onChange={(e) => { setInputEmail(e.target.value); setAddError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          disabled={adding}
          style={{
            flex: 1,
            padding: '0.45rem 0.75rem',
            borderRadius: '6px',
            border: '1px solid var(--color-border, #444)',
            background: 'var(--color-input-bg, #1a1a1a)',
            color: 'inherit',
            fontSize: '0.875rem',
          }}
        />
        <button
          onClick={handleAdd}
          disabled={adding}
          className="storage-settings-primary"
          style={{ whiteSpace: 'nowrap' }}
        >
          {adding ? 'Adding…' : 'Add Admin'}
        </button>
      </div>
      {addError && (
        <p style={{ color: 'var(--color-error, #e55)', fontSize: '0.8rem', marginTop: '0.4rem' }}>
          {addError}
        </p>
      )}
    </div>
  );
}
