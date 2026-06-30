'use client';

/**
 * Phase E: Shared "Create Review Link" modal.
 *
 * Used by all three entry points:
 *   - MediaTab bulk bar's "Create share link" button (pre-selects the user's
 *     bulk-bar selection)
 *   - MediaDetailPanel's "Share" button (pre-selects the single asset)
 *   - Review Links panel's "+ New Review Link" button (no pre-selection; user
 *     picks from all project assets)
 *
 * The modal renders the same UI in all three cases: a required Name field, a
 * checkbox list of available assets with the entry-point's pre-selection
 * already checked, optional settings (downloads toggle, expiration date), and
 * a Create button. On success it switches to a "success" pane that shows the
 * short URL with a copy button, then the parent decides what to do (close,
 * navigate to the panel, etc.).
 *
 * Assets without a Frame.io upload are still shown but disabled with a hint —
 * users see why they can't share them rather than silently disappearing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Deliverable } from '@/lib/models/deliverable';
import type { InternalReview } from '@/lib/models/internal-review';

export interface DeliverableModalAsset {
  assetId: string;
  name: string;
  hasFrameio: boolean;        // false = no frameio.assetId AND no frameio.stackId
}

export interface DeliverableModalProps {
  projectId: string;
  availableAssets: DeliverableModalAsset[];
  initiallySelectedAssetIds?: string[];
  /** Suggested initial name. Empty string = no suggestion (user must type). */
  defaultName?: string;
  onClose: () => void;
  onCreated: (deliverable: Deliverable, shareUrl: string) => void;
  /** Fired when an *internal* review (not a Frame.io deliverable) is created.
   *  Only passed by surfaces that list internal reviews (e.g. DeliverablesPanel);
   *  other entry points omit it and the modal just shows the copy-link pane. */
  onInternalCreated?: (review: InternalReview, url: string) => void;
}

interface SuccessState {
  internal: boolean;
  name: string;
  shareUrl: string;
  skippedAssetIds: string[];
}

export function DeliverableModal({
  projectId,
  availableAssets,
  initiallySelectedAssetIds = [],
  defaultName = '',
  onClose,
  onCreated,
  onInternalCreated,
}: Readonly<DeliverableModalProps>) {
  const [name, setName] = useState(defaultName);
  const [internal, setInternal] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initiallySelectedAssetIds.filter((id) =>
      availableAssets.some((a) => a.assetId === id && a.hasFrameio),
    )),
  );
  const [expiresAt, setExpiresAt] = useState(''); // empty = no expiry; HTML date input
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [copied, setCopied] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameInputRef.current?.focus(); }, []);

  // Escape closes (regardless of success state — the user can dismiss anytime).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shareableAssets = useMemo(
    () => availableAssets.filter((a) => a.hasFrameio),
    [availableAssets],
  );
  // Internal reviews don't need Frame.io, so every asset is selectable; Frame.io
  // review links stay gated to assets already uploaded to Frame.io.
  const selectableAssets = internal ? availableAssets : shareableAssets;
  const nonShareableCount = availableAssets.length - shareableAssets.length;

  function toggle(assetId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }

  function setInternalMode(next: boolean) {
    setInternal(next);
    setError(null);
    // Leaving internal mode: drop any non-Frame.io picks that can't be shared.
    if (!next) {
      setSelected((prev) => {
        const filtered = new Set([...prev].filter((id) =>
          availableAssets.some((a) => a.assetId === id && a.hasFrameio),
        ));
        return filtered;
      });
    }
  }

  function selectAll() {
    setSelected(new Set(selectableAssets.map((a) => a.assetId)));
  }
  function clearAll() {
    setSelected(new Set());
  }

  async function handleCreate() {
    if (creating) return;
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      nameInputRef.current?.focus();
      return;
    }
    if (selected.size === 0) {
      setError('Select at least one asset.');
      return;
    }
    setCreating(true);
    try {
      if (internal) {
        // LPOS-hosted internal review — no Frame.io. Posts to the separate
        // internal-reviews store; existing deliverables path is untouched.
        const res = await fetch(`/api/projects/${projectId}/internal-reviews`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetIds: Array.from(selected), name: name.trim() }),
        });
        const data = await res.json() as {
          review?: InternalReview;
          url?: string;
          error?: string;
        };
        if (!res.ok || !data.review || !data.url) {
          setError(data.error ?? 'Failed to create internal review.');
          return;
        }
        const absoluteUrl = `${window.location.origin}${data.url}`;
        setSuccess({ internal: true, name: data.review.name, shareUrl: absoluteUrl, skippedAssetIds: [] });
        onInternalCreated?.(data.review, data.url);
        return;
      }

      const res = await fetch(`/api/projects/${projectId}/deliverables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetIds: Array.from(selected),
          name: name.trim(),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      const data = await res.json() as {
        deliverable?: Deliverable;
        shareUrl?: string;
        skippedAssetIds?: string[];
        error?: string;
      };
      if (!res.ok || !data.deliverable || !data.shareUrl) {
        setError(data.error ?? 'Failed to create deliverable.');
        return;
      }
      setSuccess({
        internal: false,
        name: data.deliverable.name,
        shareUrl: data.shareUrl,
        skippedAssetIds: data.skippedAssetIds ?? [],
      });
      onCreated(data.deliverable, data.shareUrl);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function copyUrl() {
    if (!success) return;
    try {
      await navigator.clipboard.writeText(success.shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — leave the URL visible so the user can manually copy.
    }
  }

  return (
    <div
      className="sh-modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="sh-modal"
        role="dialog"
        aria-modal="true"
        aria-label={(() => {
          const isInternal = success ? success.internal : internal;
          if (success) return isInternal ? 'Internal review created' : 'Review link created';
          return isInternal ? 'Create internal review' : 'Create review link';
        })()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sh-modal-header">
          <span>{(() => {
            const isInternal = success ? success.internal : internal;
            if (success) return isInternal ? 'Internal review created' : 'Review link created';
            return isInternal ? 'Create internal review' : 'Create review link';
          })()}</span>
          <button
            type="button"
            className="sh-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {success ? (
          <>
            <div className="sh-modal-body">
              <div className="sh-modal-field">
                <label className="sh-modal-label">{success.internal ? 'Internal review link' : 'Share URL'}</label>
                <div className="deliverable-modal-url-row">
                  <input
                    className="sh-modal-input"
                    type="text"
                    value={success.shareUrl}
                    readOnly
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="sh-btn sh-btn--primary"
                    onClick={() => void copyUrl()}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
              <p className="deliverable-modal-success-hint">
                "{success.name}" is ready.
                {success.internal
                  ? ' Share this link with signed-in LPOS teammates — it opens inside LPOS.'
                  : success.skippedAssetIds.length > 0 && (
                    <> {success.skippedAssetIds.length} asset{success.skippedAssetIds.length === 1 ? '' : 's'} skipped (no Frame.io upload yet).</>
                  )}
              </p>
            </div>
            <div className="sh-modal-footer">
              <button type="button" className="sh-btn sh-btn--primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="sh-modal-body">
              <div className="sh-modal-field">
                <label className="sh-modal-label" htmlFor="deliverable-name">Name</label>
                <input
                  ref={nameInputRef}
                  id="deliverable-name"
                  className="sh-modal-input"
                  type="text"
                  placeholder="e.g. Round 2 review, Final cuts, Hero video"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleCreate();
                    }
                  }}
                />
              </div>

              <label className="sh-modal-field deliverable-modal-internal-toggle">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternalMode(e.target.checked)}
                />
                <span className="deliverable-modal-internal-toggle-text">
                  <span className="deliverable-modal-internal-toggle-title">Internal Review</span>
                  <span className="deliverable-modal-internal-toggle-desc">
                    Host in LPOS for the team — no Frame.io. Opens an in-app page signed-in teammates can watch and comment on.
                  </span>
                </span>
              </label>

              <div className="sh-modal-field">
                <div className="deliverable-modal-asset-header">
                  <label className="sh-modal-label">
                    Assets ({selected.size} of {selectableAssets.length} selected)
                  </label>
                  {selectableAssets.length > 1 && (
                    <div className="deliverable-modal-select-controls">
                      <button type="button" className="deliverable-modal-link-btn" onClick={selectAll}>
                        Select all
                      </button>
                      <button type="button" className="deliverable-modal-link-btn" onClick={clearAll}>
                        Clear
                      </button>
                    </div>
                  )}
                </div>
                {availableAssets.length === 0 ? (
                  <p className="sh-modal-hint">No assets available.</p>
                ) : (
                  <div className="sh-modal-asset-list">
                    {availableAssets.map((a) => {
                      const disabled = !internal && !a.hasFrameio;
                      return (
                        <label
                          key={a.assetId}
                          className={`sh-modal-asset-row${disabled ? ' deliverable-modal-asset-row--disabled' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(a.assetId)}
                            disabled={disabled}
                            onChange={() => toggle(a.assetId)}
                          />
                          <span>{a.name}</span>
                          {disabled && (
                            <span className="deliverable-modal-asset-note">— not on Frame.io yet</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
                {!internal && nonShareableCount > 0 && (
                  <p className="sh-modal-hint">
                    {nonShareableCount} asset{nonShareableCount === 1 ? '' : 's'} can't be shared until uploaded to Frame.io.
                  </p>
                )}
              </div>

              {!internal && (
                <div className="sh-modal-field">
                  <label className="sh-modal-label" htmlFor="deliverable-expires">
                    Expiration (optional)
                  </label>
                  <input
                    id="deliverable-expires"
                    className="sh-modal-input"
                    type="date"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                  />
                </div>
              )}

              {error && <p className="sh-error">{error}</p>}
            </div>
            <div className="sh-modal-footer">
              <button type="button" className="sh-btn" onClick={onClose} disabled={creating}>
                Cancel
              </button>
              <button
                type="button"
                className="sh-btn sh-btn--primary"
                onClick={() => void handleCreate()}
                disabled={creating || selected.size === 0 || !name.trim()}
              >
                {creating ? 'Creating…' : internal ? 'Create internal review' : 'Create review link'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
