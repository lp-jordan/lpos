'use client';

import { useEffect, useState } from 'react';

interface EpTokenRow {
  tokenId:     string;
  machineName: string;
  createdAt:   string;
  lastUsedAt:  string | null;
  revokedAt:   string | null;
  user: { id: string; email: string; name: string };
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000)             return 'just now';
  if (diff < 3_600_000)          return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 3_600_000)     return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / (24 * 3_600_000))}d ago`;
}

export function EpTokensPanel() {
  const [rows, setRows]         = useState<EpTokenRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/admin/ep-tokens');
      if (!res.ok) throw new Error('Failed to load EditPanel devices.');
      const data = await res.json() as { tokens: EpTokenRow[] };
      setRows(data.tokens);
    } catch {
      setError('Could not load the EditPanel device list.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function handleRevoke(tokenId: string) {
    if (!confirm('Revoke this EditPanel device? The machine will be signed out on its next request.')) return;
    setRevoking(tokenId);
    try {
      const res = await fetch(`/api/admin/ep-tokens/${encodeURIComponent(tokenId)}/revoke`, { method: 'POST' });
      if (!res.ok) throw new Error('Revoke failed');
      await load();
    } catch {
      setError('Could not revoke the device. Please try again.');
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="storage-settings-card">
      <h2 className="storage-settings-section-title">Connected EditPanel devices</h2>
      <p className="storage-settings-muted">
        Each row is a per-user, per-machine approval issued by /ep/link. Revoking a device signs that
        machine out — the user can re-approve from EditPanel Settings any time.
      </p>

      {loading && <p className="storage-settings-muted">Loading…</p>}
      {error && <p className="storage-settings-muted" style={{ color: '#ffb4ab' }}>{error}</p>}

      {!loading && rows.length === 0 && (
        <p className="storage-settings-muted">No EditPanel devices have signed in yet.</p>
      )}

      {!loading && rows.length > 0 && (
        <table className="storage-settings-table" style={{ width: '100%', marginTop: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>User</th>
              <th style={{ textAlign: 'left' }}>Machine</th>
              <th style={{ textAlign: 'left' }}>Approved</th>
              <th style={{ textAlign: 'left' }}>Last used</th>
              <th style={{ textAlign: 'left' }}>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tokenId}>
                <td>
                  <div>{r.user.name || r.user.email}</div>
                  <div className="storage-settings-muted" style={{ fontSize: '0.8em' }}>{r.user.email}</div>
                </td>
                <td>{r.machineName}</td>
                <td>{formatTimeAgo(r.createdAt)}</td>
                <td>{formatTimeAgo(r.lastUsedAt)}</td>
                <td>{r.revokedAt ? <span style={{ opacity: 0.6 }}>Revoked</span> : <span>Active</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  {!r.revokedAt && (
                    <button
                      type="button"
                      onClick={() => handleRevoke(r.tokenId)}
                      disabled={revoking === r.tokenId}
                      className="storage-settings-danger"
                    >
                      {revoking === r.tokenId ? 'Revoking…' : 'Revoke'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
