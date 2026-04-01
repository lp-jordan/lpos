'use client';

import { useState } from 'react';

export function RestartButton() {
  const [showDialog, setShowDialog] = useState(false);
  const [autoRestart, setAutoRestart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/admin/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoRestart }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string; counts?: { ingest: number; transcripts: number; uploads: number } };
        if (data.error === 'jobs_in_progress') {
          const c = data.counts;
          const parts: string[] = [];
          if (c && c.ingest > 0) parts.push(`${c.ingest} ingest`);
          if (c && c.transcripts > 0) parts.push(`${c.transcripts} transcription`);
          if (c && c.uploads > 0) parts.push(`${c.uploads} upload`);
          setError(`Jobs in progress: ${parts.join(', ')}. Wait for them to finish.`);
        } else if (data.error === 'already_pending') {
          setError('Restart is already counting down.');
        } else {
          setError('Failed to initiate restart.');
        }
        setBusy(false);
        return;
      }

      // On success the banner appears via Socket.IO — close the dialog
      setShowDialog(false);
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="user-menu-link user-menu-link--button user-menu-link--danger"
        onClick={() => { setError(null); setShowDialog(true); }}
      >
        Restart Server
      </button>

      {showDialog && (
        <div className="restart-dialog-overlay" onClick={() => !busy && setShowDialog(false)}>
          <div className="restart-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="restart-dialog-title">Restart LPOS?</h3>
            <p className="restart-dialog-body">
              A 60-second countdown will broadcast to all users, then the server shuts down.
            </p>

            <label className="restart-dialog-option">
              <input
                type="checkbox"
                checked={autoRestart}
                onChange={(e) => setAutoRestart(e.target.checked)}
                disabled={busy}
              />
              <span>Auto-restart after shutdown</span>
            </label>
            {!autoRestart && (
              <p className="restart-dialog-hint">
                Server will stay down until you start it manually.
              </p>
            )}

            {error && <div className="user-menu-restart-error">{error}</div>}

            <div className="restart-dialog-actions">
              <button
                type="button"
                className="modal-btn-ghost"
                onClick={() => setShowDialog(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn-danger"
                onClick={handleConfirm}
                disabled={busy}
              >
                {busy ? 'Initiating…' : 'Start Countdown'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
