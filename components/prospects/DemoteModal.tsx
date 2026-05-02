'use client';

import { useState } from 'react';

interface Props {
  companyName: string;
  clientName:  string;
  onConfirm:   () => Promise<void>;
  onClose:     () => void;
}

export function DemoteModal({ companyName, clientName, onConfirm, onClose }: Props) {
  const [demoting, setDemoting] = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  async function handleConfirm() {
    setDemoting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError((err as Error).message);
      setDemoting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Demote Prospect</h2>
        </div>

        <div style={{ padding: '0 1.5rem 0.5rem' }}>
          <p style={{ margin: '0 0 10px', fontSize: '0.875rem', color: 'var(--muted)', lineHeight: 1.6 }}>
            This will revert{' '}
            <strong style={{ color: 'var(--text)' }}>{companyName}</strong>{' '}
            from client status back to an active prospect (Contract Signed stage).
          </p>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)', lineHeight: 1.6 }}>
            All projects, assets, and data under{' '}
            <strong style={{ color: 'var(--text)' }}>{clientName}</strong>{' '}
            are preserved. If re-promoted later, the same client record is restored.
          </p>

          {error && (
            <p style={{ color: 'var(--color-error,#e55)', fontSize: '0.82rem', margin: '12px 0 0' }}>
              {error}
            </p>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={demoting}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={demoting}
            style={{
              padding: '0.45rem 1.1rem', borderRadius: 6, fontSize: '0.875rem', fontWeight: 600,
              background: 'var(--color-error,#c33)', color: '#fff',
              border: 'none', cursor: demoting ? 'wait' : 'pointer',
            }}
          >
            {demoting ? 'Demoting…' : 'Demote'}
          </button>
        </div>
      </div>
    </div>
  );
}
