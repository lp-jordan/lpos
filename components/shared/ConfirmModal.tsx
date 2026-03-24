'use client';

import { useState } from 'react';

interface Props {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export function ConfirmModal({
  title, body, confirmLabel = 'Confirm', danger = false, onConfirm, onClose,
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
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
