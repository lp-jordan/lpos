'use client';

import { useState } from 'react';

interface Props {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Inline error shown below the body. When present, the modal stays open after confirm. */
  error?: string | null;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export function ConfirmModal({
  title, body, confirmLabel = 'Confirm', danger = false, error, onConfirm, onClose,
}: Readonly<Props>) {
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
        </div>
        <p className="modal-body-text">{body}</p>
        {error && (
          <p className="modal-body-text" style={{ color: '#e07070', marginTop: '0.5rem' }}>
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'modal-btn-danger' : 'modal-btn-primary'}
            disabled={busy}
            onClick={handleConfirm}
          >
            {busy ? 'Working…' : (error ? 'Retry' : confirmLabel)}
          </button>
        </div>
      </div>
    </div>
  );
}
