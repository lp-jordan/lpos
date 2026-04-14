'use client';

import { useState, useEffect, useCallback } from 'react';

interface ClientInfo {
  userId: string;
  name: string;
  email: string | null;
  connectedAt: number;
  focused: boolean;
  lastFocusedAt: number | null;
  lastBlurredAt: number | null;
}

function relativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function ActiveClientsCard() {
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/presence');
      if (res.ok) {
        const data = await res.json() as { clients: ClientInfo[] };
        setClients(data.clients);
        setFetchedAt(Date.now());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="storage-settings-card">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2 className="storage-settings-section-title">Active Clients</h2>
          <p className="storage-settings-muted">
            Who currently has LPOS open in a browser tab. Safe to restart when this list is empty
            or all tabs are backgrounded.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          style={{
            padding: '0.4rem 1rem',
            fontSize: '0.85rem',
            cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.5 : 1,
            background: 'var(--color-surface-raised, #222)',
            color: 'var(--color-text, #fff)',
            border: '1px solid var(--color-border, #444)',
            borderRadius: '6px',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {!loading && clients.length === 0 && (
        <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: 'var(--color-text-muted, #888)' }}>
          No active connections.
        </p>
      )}

      {clients.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {clients.map((c) => (
            <li
              key={c.userId + c.connectedAt}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem',
                padding: '0.5rem 0.75rem',
                background: 'var(--color-surface-raised, #222)',
                borderRadius: '6px',
                fontSize: '0.875rem',
              }}
            >
              <div>
                <span style={{ fontWeight: 600, color: 'var(--color-text, #fff)' }}>{c.name}</span>
                {c.email && (
                  <span style={{ marginLeft: '0.5rem', color: 'var(--color-text-muted, #888)', fontSize: '0.8rem' }}>
                    {c.email}
                  </span>
                )}
                <span style={{ marginLeft: '0.75rem', color: 'var(--color-text-muted, #888)', fontSize: '0.75rem' }}>
                  connected {relativeTime(c.connectedAt)}
                </span>
              </div>
              <span
                style={{
                  padding: '0.2rem 0.6rem',
                  borderRadius: '999px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  background: c.focused ? 'var(--color-success-bg, #1a3a1a)' : 'var(--color-surface, #333)',
                  color: c.focused ? 'var(--color-success, #4caf50)' : 'var(--color-text-muted, #888)',
                  border: `1px solid ${c.focused ? 'var(--color-success, #4caf50)' : 'var(--color-border, #444)'}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {c.focused ? 'In focus' : 'Backgrounded'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {fetchedAt && (
        <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--color-text-muted, #888)' }}>
          Last checked {relativeTime(fetchedAt)}
        </p>
      )}
    </div>
  );
}
