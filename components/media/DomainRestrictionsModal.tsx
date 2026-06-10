'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  projectId: string;
  assetId: string;
  assetName?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

type Phase = 'loading' | 'idle' | 'saving' | 'error';

// Cloudflare accepts bare hosts ("example.com") and wildcards ("*.example.com")
// in `allowedOrigins`. We strip protocol/path/port if the user pastes a URL so
// the saved value matches what Cloudflare actually checks against.
function normalizeOrigin(raw: string): string {
  let v = raw.trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^https?:\/\//, '');
  v = v.replace(/\/.*$/, '');
  v = v.replace(/:\d+$/, '');
  return v;
}

function isValidOrigin(value: string): boolean {
  if (!value) return false;
  // host (with optional leading *.) — letters, digits, dots, hyphens.
  return /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value);
}

export function DomainRestrictionsModal({ projectId, assetId, assetName, onClose, onSaved }: Readonly<Props>) {
  const [phase, setPhase]     = useState<Phase>('loading');
  const [origins, setOrigins] = useState<string[]>([]);
  const [draft, setDraft]     = useState('');
  const [error, setError]     = useState<string | null>(null);
  const [dirty, setDirty]     = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Load current allowedOrigins from Cloudflare ───────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/media/${assetId}/cloudflare`, { method: 'GET' });
        const data = await res.json() as { allowedOrigins?: string[]; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setPhase('error');
          setError(data.error ?? `Failed to load (HTTP ${res.status}).`);
          return;
        }
        setOrigins(Array.isArray(data.allowedOrigins) ? data.allowedOrigins : []);
        setPhase('idle');
        setTimeout(() => inputRef.current?.focus(), 0);
      } catch (err) {
        if (cancelled) return;
        setPhase('error');
        setError(err instanceof Error ? err.message : 'Network error.');
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, assetId]);

  const addDraft = useCallback(() => {
    const normalized = normalizeOrigin(draft);
    if (!normalized) return;
    if (!isValidOrigin(normalized)) {
      setError(`"${draft.trim()}" is not a valid domain. Use e.g. example.com or *.example.com.`);
      return;
    }
    if (origins.includes(normalized)) {
      setDraft('');
      return;
    }
    setError(null);
    setOrigins((prev) => [...prev, normalized]);
    setDraft('');
    setDirty(true);
  }, [draft, origins]);

  const removeOrigin = useCallback((value: string) => {
    setOrigins((prev) => prev.filter((o) => o !== value));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    setPhase('saving');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${assetId}/cloudflare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedOrigins: origins }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setPhase('error');
        setError(data.error ?? `Save failed (HTTP ${res.status}).`);
        return;
      }
      setDirty(false);
      onSaved?.();
      onClose();
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : 'Network error.');
    }
  }, [projectId, assetId, origins, onSaved, onClose]);

  const tryClose = useCallback(() => {
    if (phase === 'saving') return;
    if (dirty) {
      const ok = window.confirm('You have unsaved changes. Discard them?');
      if (!ok) return;
    }
    onClose();
  }, [phase, dirty, onClose]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') tryClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tryClose]);

  const isBusy = phase === 'loading' || phase === 'saving';

  return (
    <>
      <div className="sardius-modal-backdrop" onClick={tryClose} aria-hidden="true" />
      <div className="sardius-modal" role="dialog" aria-label="Domain Restrictions" aria-modal="true">
        <div className="sardius-modal-header">
          <span className="sardius-modal-title">
            Domain Restrictions
            {assetName && <span className="sardius-modal-count"> — {assetName}</span>}
          </span>
          <button
            type="button"
            className="mad-close-btn"
            onClick={tryClose}
            aria-label="Close"
            style={{ marginLeft: 'auto' }}
            disabled={phase === 'saving'}
          >
            ×
          </button>
        </div>

        <div className="sardius-modal-body">
          <div className="sardius-section">
            <p className="proj-upload-zone-hint" style={{ marginTop: 0 }}>
              Limit which domains may embed and play this Cloudflare Stream video. Leave the list
              empty to allow playback from anywhere (Cloudflare default). Wildcards like
              <code style={{ margin: '0 4px' }}>*.example.com</code> are supported.
            </p>

            {phase === 'loading' ? (
              <p className="proj-upload-zone-hint" style={{ marginTop: 8 }}>Loading current restrictions…</p>
            ) : (
              <>
                <div className="mad-cf-origin-input-row" style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  <input
                    ref={inputRef}
                    type="text"
                    className="mad-field-input"
                    placeholder="example.com or *.example.com"
                    value={draft}
                    onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); addDraft(); }
                    }}
                    disabled={isBusy}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="mad-action-btn"
                    onClick={addDraft}
                    disabled={isBusy || !draft.trim()}
                  >
                    Add
                  </button>
                </div>

                <ul
                  className="mad-cf-origin-list"
                  style={{
                    listStyle: 'none', padding: 0, margin: '12px 0 0',
                    display: 'flex', flexDirection: 'column', gap: 4,
                    maxHeight: 220, overflowY: 'auto',
                  }}
                >
                  {origins.length === 0 ? (
                    <li className="proj-upload-zone-hint" style={{ fontStyle: 'italic' }}>
                      No restrictions — this video plays on any domain.
                    </li>
                  ) : (
                    origins.map((o) => (
                      <li
                        key={o}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '6px 10px', background: 'rgba(255,255,255,0.04)',
                          borderRadius: 4, fontFamily: 'monospace', fontSize: 12,
                        }}
                      >
                        <span>{o}</span>
                        <button
                          type="button"
                          className="mad-close-btn"
                          onClick={() => removeOrigin(o)}
                          disabled={isBusy}
                          aria-label={`Remove ${o}`}
                          title="Remove"
                          style={{ marginLeft: 8 }}
                        >
                          ×
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </>
            )}

            {error && <p className="mad-error" style={{ marginTop: 8 }}>{error}</p>}
          </div>
        </div>

        <div className="sardius-modal-footer">
          <button
            type="button"
            className="mad-action-btn"
            onClick={tryClose}
            disabled={phase === 'saving'}
          >
            Cancel
          </button>
          <button
            type="button"
            className="mad-action-btn mad-action-btn--primary"
            onClick={() => void save()}
            disabled={isBusy || !dirty}
            title={!dirty ? 'No changes to save' : undefined}
          >
            {phase === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
