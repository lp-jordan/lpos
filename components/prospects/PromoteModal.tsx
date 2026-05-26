'use client';

import { useState } from 'react';

export type PromoteResult =
  | { mode: 'new';      clientName: string }
  | { mode: 'existing'; existingClientId: string; existingClientName: string };

interface ExistingClient {
  clientId: string;
  name:     string;
}

interface Props {
  companyName:     string;
  existingClients: ExistingClient[];
  onConfirm:       (result: PromoteResult) => Promise<void>;
  onClose:         () => void;
}

export function PromoteModal({ companyName, existingClients, onConfirm, onClose }: Props) {
  const [mode,           setMode]           = useState<'new' | 'existing'>('new');
  const [clientName,     setClientName]     = useState(companyName);
  const [selectedId,     setSelectedId]     = useState('');
  const [clientSearch,   setClientSearch]   = useState('');
  const [promoting,      setPromoting]      = useState(false);
  const [error,          setError]          = useState<string | null>(null);

  const filteredClients = existingClients.filter((c) =>
    c.name.toLowerCase().includes(clientSearch.toLowerCase()),
  );

  const selectedClient = existingClients.find((c) => c.clientId === selectedId);

  const canConfirm = mode === 'new'
    ? clientName.trim().length > 0
    : selectedId.length > 0;

  async function handleConfirm() {
    if (!canConfirm) return;
    setPromoting(true);
    setError(null);
    try {
      if (mode === 'new') {
        await onConfirm({ mode: 'new', clientName: clientName.trim() });
      } else {
        await onConfirm({
          mode:               'existing',
          existingClientId:   selectedId,
          existingClientName: selectedClient!.name,
        });
      }
    } catch (err) {
      setError((err as Error).message);
      setPromoting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Promote to Client</h2>
        </div>

        <div style={{ padding: '0 1.5rem 0.5rem' }}>
          <p style={{ margin: '0 0 20px', fontSize: '0.875rem', color: 'var(--muted)', lineHeight: 1.6 }}>
            Promoting{' '}
            <strong style={{ color: 'var(--text)' }}>{companyName}</strong>{' '}
            to an active client. This cannot be undone.
          </p>

          {/* Mode toggle */}
          {existingClients.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
              {(['new', 'existing'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  disabled={promoting}
                  style={{
                    flex: 1, padding: '0.4rem 0', borderRadius: 6, fontSize: '0.8rem', fontWeight: 600,
                    border: `1px solid ${mode === m ? 'var(--accent)' : 'var(--color-border,#444)'}`,
                    background: mode === m ? 'var(--accent-soft)' : 'var(--color-input-bg,#1a1a1a)',
                    color: mode === m ? 'var(--accent-strong)' : 'var(--muted)',
                    cursor: promoting ? 'default' : 'pointer',
                  }}
                >
                  {m === 'new' ? 'New client' : 'Add to existing'}
                </button>
              ))}
            </div>
          )}

          {/* New client */}
          {mode === 'new' && (
            <>
              <label style={{
                display: 'block', marginBottom: 6,
                fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--muted-soft)',
              }}>
                Client Name
              </label>
              <input
                type="text"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                disabled={promoting}
                autoFocus
                className="modal-input"
                onKeyDown={(e) => { if (e.key === 'Enter' && canConfirm) void handleConfirm(); }}
              />
            </>
          )}

          {/* Existing client picker */}
          {mode === 'existing' && (
            <>
              <label style={{
                display: 'block', marginBottom: 6,
                fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--muted-soft)',
              }}>
                Select Client
              </label>
              <input
                type="text"
                placeholder="Search clients…"
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                disabled={promoting}
                autoFocus
                className="modal-input"
                style={{ marginBottom: 8 }}
              />
              <div style={{
                maxHeight: 180, overflowY: 'auto', borderRadius: 6,
                border: '1px solid var(--color-border,#444)',
                background: 'var(--color-input-bg,#1a1a1a)',
              }}>
                {filteredClients.length === 0 && (
                  <p style={{ margin: 0, padding: '10px 12px', fontSize: '0.8rem', color: 'var(--muted)' }}>
                    No clients found.
                  </p>
                )}
                {filteredClients.map((c) => (
                  <button
                    key={c.clientId}
                    type="button"
                    disabled={promoting}
                    onClick={() => setSelectedId(c.clientId)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '8px 12px', border: 'none', borderRadius: 0,
                      background: selectedId === c.clientId ? 'var(--accent-soft)' : 'transparent',
                      color: selectedId === c.clientId ? 'var(--accent-strong)' : 'var(--text)',
                      fontSize: '0.85rem', cursor: 'pointer',
                    }}
                  >
                    {c.name}
                    {c.clientId === selectedId && (
                      <span style={{ float: 'right', color: 'var(--accent)' }}>✓</span>
                    )}
                  </button>
                ))}
              </div>
              {selectedClient && (
                <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: 'var(--muted)' }}>
                  <strong style={{ color: 'var(--text)' }}>{companyName}</strong> will be added as a new engagement under{' '}
                  <strong style={{ color: 'var(--text)' }}>{selectedClient.name}</strong>.
                </p>
              )}
            </>
          )}

          {error && (
            <p style={{ color: 'var(--color-error,#e55)', fontSize: '0.82rem', margin: '8px 0 0' }}>
              {error}
            </p>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={promoting}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn-primary"
            onClick={handleConfirm}
            disabled={promoting || !canConfirm}
          >
            {promoting ? 'Promoting…' : 'Confirm & Promote'}
          </button>
        </div>
      </div>
    </div>
  );
}
