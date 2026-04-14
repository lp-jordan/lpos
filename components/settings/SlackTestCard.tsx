'use client';

import { useState } from 'react';

type Status = 'idle' | 'loading' | 'success' | 'error';

export function SlackTestCard() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleTest() {
    setStatus('loading');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/admin/slack-test', { method: 'POST' });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error ?? 'Unknown error');
        setStatus('error');
      } else {
        setStatus('success');
      }
    } catch {
      setErrorMsg('Request failed');
      setStatus('error');
    }
  }

  const buttonLabel = status === 'loading' ? 'Sending…' : 'Send test DM';

  return (
    <div className="storage-settings-card">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2 className="storage-settings-section-title">Slack Notifications</h2>
          <p className="storage-settings-muted">
            Sends a test DM to your Slack account to verify the bot integration is working.
          </p>
        </div>
        <button
          onClick={() => void handleTest()}
          disabled={status === 'loading'}
          style={{
            padding: '0.4rem 1rem',
            fontSize: '0.85rem',
            cursor: status === 'loading' ? 'default' : 'pointer',
            opacity: status === 'loading' ? 0.5 : 1,
            background: 'var(--color-surface-raised, #222)',
            color: 'var(--color-text, #fff)',
            border: '1px solid var(--color-border, #444)',
            borderRadius: '6px',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {buttonLabel}
        </button>
      </div>

      {status === 'success' && (
        <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--color-success, #4caf50)' }}>
          DM sent — check your Slack.
        </p>
      )}
      {status === 'error' && (
        <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--color-error, #e57373)' }}>
          {errorMsg ?? 'Something went wrong.'}
        </p>
      )}
    </div>
  );
}
