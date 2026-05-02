'use client';

import { useState } from 'react';

interface Props {
  companyName: string;
  onConfirm:   (clientName: string) => Promise<void>;
  onClose:     () => void;
}

export function PromoteModal({ companyName, onConfirm, onClose }: Props) {
  const [clientName, setClientName] = useState(companyName);
  const [promoting,  setPromoting]  = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  async function handleConfirm() {
    if (!clientName.trim()) return;
    setPromoting(true);
    setError(null);
    try {
      await onConfirm(clientName.trim());
    } catch (err) {
      setError((err as Error).message);
      setPromoting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Promote to Client</h2>
        </div>

        <div style={{ padding: '0 1.5rem 0.5rem' }}>
          <p style={{ margin: '0 0 20px', fontSize: '0.875rem', color: 'var(--muted)', lineHeight: 1.6 }}>
            This will convert{' '}
            <strong style={{ color: 'var(--text)' }}>{companyName}</strong>{' '}
            into an active client. This cannot be undone.
          </p>

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
            onKeyDown={(e) => { if (e.key === 'Enter' && clientName.trim()) void handleConfirm(); }}
          />

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
            disabled={promoting || !clientName.trim()}
          >
            {promoting ? 'Promoting…' : 'Confirm & Promote'}
          </button>
        </div>
      </div>
    </div>
  );
}
