'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { MediaAsset } from '@/lib/models/media-asset';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DeliveryLink {
  token:            string;
  project_name:     string;
  client_name:      string | null;
  label:            string | null;
  expires_at:       string;
  created_at:       string;
  asset_count:      number;
  access_count:     number;
  last_accessed_at: string | null;
  url:              string;
}

interface DeliveryItem {
  id:               number;
  assetId:          string | null;
  filename:         string;
  fileSize:         number;
  mimeType:         string;
  thumbnailUrl:     string | null;
  deliveredVersion: number | null;
  currentVersion:   number | null;
  isStale:          boolean;
  canRefresh:       boolean;
  missingLocalFile: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

function expiryMeta(expiresAt: string): { label: string; cls: string } {
  const ms   = new Date(expiresAt).getTime() - Date.now();
  const days = ms / (1000 * 60 * 60 * 24);
  if (ms < 0)     return { label: 'Expired',                   cls: 'dlp-meta--danger' };
  if (days < 2)   return { label: `Expires ${formatDate(expiresAt)}`, cls: 'dlp-meta--danger' };
  if (days < 7)   return { label: `Expires ${formatDate(expiresAt)}`, cls: 'dlp-meta--warn' };
  return           { label: `Expires ${formatDate(expiresAt)}`, cls: '' };
}

function daysFromNow(n: number): string {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

// ── Create delivery modal ─────────────────────────────────────────────────────

function CreateDeliveryModal({
  projectId,
  assets,
  preselected,
  onClose,
}: {
  projectId:   string;
  assets:      MediaAsset[];
  preselected: MediaAsset[];
  onClose:     () => void;
}) {
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(preselected.map((a) => a.assetId)),
  );
  const [label,      setLabel]      = useState('');
  const [clientName, setClientName] = useState('');
  const [expiryDays, setExpiryDays] = useState(14);
  const [phase,      setPhase]      = useState<'form' | 'queued' | 'error'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [ineligible, setIneligible] = useState<{ assetId: string; name: string; reason: string }[]>([]);
  const skippedRef = useRef(0);

  const eligible   = assets.filter((a) => a.filePath);
  const noFilePath = assets.filter((a) => !a.filePath);

  function hasThumb(a: MediaAsset) {
    return !!(a.cloudflare?.uid || a.filePath);
  }

  function toggleAsset(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    const assetIds = [...checkedIds];
    if (!assetIds.length) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/delivery`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetIds,
          label:      label.trim() || undefined,
          clientName: clientName.trim() || undefined,
          expiresAt:  new Date(`${daysFromNow(expiryDays)}T23:59:59Z`).toISOString(),
        }),
      });

      const data = await res.json() as { ok?: boolean; jobId?: string; ineligible?: typeof ineligible; error?: string };

      if (!res.ok) {
        setError(data.error ?? 'Failed to queue delivery');
        setPhase('error');
        setSubmitting(false);
        return;
      }

      skippedRef.current = data.ineligible?.length ?? 0;
      if (data.ineligible?.length) setIneligible(data.ineligible);
      setPhase('queued');
    } catch {
      setError('Network error — could not queue delivery');
      setPhase('error');
      setSubmitting(false);
    }
  }

  const EXPIRY_PRESETS = [
    { days: 7,  label: '7 days' },
    { days: 14, label: '14 days' },
    { days: 30, label: '30 days' },
    { days: 60, label: '60 days' },
  ];

  return (
    <div className="sh-modal-backdrop" onClick={onClose} aria-hidden="true">
      <div className="sh-modal dlp-create-modal" role="dialog" aria-label="Create delivery link" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="sh-modal-header">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          <span>New Delivery</span>
          <button type="button" className="sh-modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Form */}
        {phase === 'form' && (
          <>
            {/* Asset selector */}
            <p className="sh-modal-section-label">Files to include</p>
            <div className="dlp-asset-list">
              {eligible.map((a) => (
                <label key={a.assetId} className="dlp-asset-row">
                  <input
                    type="checkbox"
                    checked={checkedIds.has(a.assetId)}
                    onChange={() => toggleAsset(a.assetId)}
                    className="dlp-asset-check"
                  />
                  <span className="dlp-asset-name" title={a.name}>{a.name}</span>
                  {a.fileSize !== null && (
                    <span className="dlp-asset-size">{formatBytes(a.fileSize)}</span>
                  )}
                  {!hasThumb(a) && (
                    <span className="dlp-asset-warn dlp-asset-warn--soft" title="No thumbnail available — will show a generic icon on the delivery page">no preview</span>
                  )}
                </label>
              ))}
              {noFilePath.map((a) => (
                <div key={a.assetId} className="dlp-asset-row dlp-asset-row--ineligible">
                  <input type="checkbox" disabled className="dlp-asset-check" />
                  <span className="dlp-asset-name" title={a.name}>{a.name}</span>
                  <span className="dlp-asset-warn">Frame.io only</span>
                </div>
              ))}
              {assets.length === 0 && (
                <p className="sh-empty" style={{ padding: '8px 0' }}>No assets in this project.</p>
              )}
            </div>

            {/* Fields */}
            <div className="dlp-fields">
              <div className="dlp-field">
                <label className="dlp-field-label">Label <span className="dlp-field-optional">(optional)</span></label>
                <input
                  className="dlp-field-input"
                  type="text"
                  placeholder="e.g. Round 1 Deliverables"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={120}
                />
              </div>
              <div className="dlp-field">
                <label className="dlp-field-label">Client name <span className="dlp-field-optional">(optional)</span></label>
                <input
                  className="dlp-field-input"
                  type="text"
                  placeholder="e.g. Jordan"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  maxLength={80}
                />
              </div>
              <div className="dlp-field">
                <label className="dlp-field-label">Link expires after</label>
                <div className="dlp-expiry-presets">
                  {EXPIRY_PRESETS.map((p) => (
                    <button
                      key={p.days}
                      type="button"
                      className={`dlp-preset-btn${expiryDays === p.days ? ' dlp-preset-btn--active' : ''}`}
                      onClick={() => setExpiryDays(p.days)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              type="button"
              className="sh-btn sh-btn--primary dlp-submit-btn"
              disabled={checkedIds.size === 0 || submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting ? 'Queuing…' : 'Create delivery link'}
            </button>
          </>
        )}

        {/* Queued */}
        {phase === 'queued' && (
          <div className="dlp-result">
            <div className="dlp-result-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <p className="dlp-result-title">Delivery queued</p>
            <p className="dlp-uploading-text">
              Files are uploading in the background — watch the upload tray for progress.
              The link will appear here when it's ready.
            </p>
            {ineligible.length > 0 && (
              <p className="dlp-result-warn">
                {ineligible.length} file{ineligible.length !== 1 ? 's' : ''} skipped (no local copy).
              </p>
            )}
            {(() => {
              const noThumbCount = eligible.filter((a) => checkedIds.has(a.assetId) && !hasThumb(a)).length;
              return noThumbCount > 0 ? (
                <p className="dlp-result-info">
                  {noThumbCount} file{noThumbCount !== 1 ? 's' : ''} will show a generic icon — no thumbnail was available.
                </p>
              ) : null;
            })()}
            <button type="button" className="sh-btn dlp-done-btn" onClick={onClose}>Got it</button>
          </div>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div className="dlp-result">
            <p className="sh-error" style={{ marginBottom: '12px' }}>{error}</p>
            <button type="button" className="sh-btn" onClick={() => setPhase('form')}>Back</button>
          </div>
        )}

      </div>
    </div>
  );
}

// ── Add videos modal ───────────────────────────────────────────────────────────

function AddVideosModal({
  projectId,
  token,
  assets,
  existingAssetIds,
  onClose,
  onQueued,
}: {
  projectId:        string;
  token:            string;
  assets:           MediaAsset[];
  existingAssetIds: Set<string>;
  onClose:          () => void;
  onQueued:         () => void;
}) {
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  // Only assets with a local file and not already on the link can be added.
  const addable = assets.filter((a) => a.filePath && !existingAssetIds.has(a.assetId));

  function toggle(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleAdd() {
    const assetIds = [...checkedIds];
    if (!assetIds.length) return;
    setSubmitting(true);
    setError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/delivery/${token}/assets`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ assetIds }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) { setError(data.error ?? 'Failed to add videos'); setSubmitting(false); return; }
      onQueued();
      onClose();
    } catch {
      setError('Network error — could not add videos');
      setSubmitting(false);
    }
  }

  return (
    <div className="sh-modal-backdrop" onClick={onClose} aria-hidden="true">
      <div className="sh-modal dlp-create-modal" role="dialog" aria-label="Add videos to delivery link" onClick={(e) => e.stopPropagation()}>
        <div className="sh-modal-header">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          <span>Add videos</span>
          <button type="button" className="sh-modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <p className="sh-modal-section-label">Videos to add</p>
        <div className="dlp-asset-list">
          {addable.map((a) => (
            <label key={a.assetId} className="dlp-asset-row">
              <input type="checkbox" checked={checkedIds.has(a.assetId)} onChange={() => toggle(a.assetId)} className="dlp-asset-check" />
              <span className="dlp-asset-name" title={a.name}>{a.name}</span>
              {a.fileSize !== null && <span className="dlp-asset-size">{formatBytes(a.fileSize)}</span>}
            </label>
          ))}
          {addable.length === 0 && (
            <p className="sh-empty" style={{ padding: '8px 0' }}>
              No videos left to add — every deliverable asset is already on this link.
            </p>
          )}
        </div>

        {error && <p className="sh-error" style={{ marginTop: 8 }}>{error}</p>}

        <button
          type="button"
          className="sh-btn sh-btn--primary dlp-submit-btn"
          disabled={checkedIds.size === 0 || submitting}
          onClick={() => void handleAdd()}
        >
          {submitting ? 'Adding…' : checkedIds.size > 0 ? `Add ${checkedIds.size} video${checkedIds.size !== 1 ? 's' : ''}` : 'Add videos'}
        </button>
      </div>
    </div>
  );
}

// ── Delivery link card ────────────────────────────────────────────────────────

function DeliveryLinkCard({
  link,
  projectId,
  assets,
  onRevoked,
  onUpdated,
  onRefetch,
}: {
  link:      DeliveryLink;
  projectId: string;
  assets:    MediaAsset[];
  onRevoked: (token: string) => void;
  onUpdated: (token: string, patch: Partial<DeliveryLink>) => void;
  onRefetch: () => void;
}) {
  const [copied,      setCopied]      = useState(false);
  const [revoking,    setRevoking]    = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [editing,     setEditing]     = useState(false);
  const [editLabel,   setEditLabel]   = useState(link.label ?? '');
  const [editSaving,  setEditSaving]  = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Expandable video list + version tracking
  const [expanded,     setExpanded]     = useState(false);
  const [items,        setItems]        = useState<DeliveryItem[] | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError,   setItemsError]   = useState<string | null>(null);
  const [refreshing,   setRefreshing]   = useState(false);
  const [showAdd,      setShowAdd]      = useState(false);
  const [notice,       setNotice]       = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setItemsLoading(true);
    setItemsError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/delivery/${link.token}/items`);
      const data = await res.json() as { items?: DeliveryItem[]; error?: string };
      if (!res.ok) { setItemsError(data.error ?? 'Failed to load videos'); return; }
      setItems(data.items ?? []);
    } catch {
      setItemsError('Network error — could not load videos');
    } finally {
      setItemsLoading(false);
    }
  }, [projectId, link.token]);

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (next && items === null) void loadItems();
  }

  async function handleRefresh() {
    setRefreshing(true);
    setNotice(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/delivery/${link.token}/refresh`, { method: 'POST' });
      const data = await res.json() as { ok?: boolean; refreshed?: number; error?: string };
      if (!res.ok) { setNotice(data.error ?? 'Refresh failed'); return; }
      if (!data.refreshed) { setNotice('Everything is already up to date.'); return; }
      setNotice(`Updating ${data.refreshed} video${data.refreshed !== 1 ? 's' : ''} to the latest version — watch the upload tray.`);
    } catch {
      setNotice('Network error — could not refresh');
    } finally {
      setRefreshing(false);
    }
  }

  const staleCount = items?.filter((i) => i.isStale).length ?? 0;
  const refreshableCount = items?.filter((i) => i.canRefresh).length ?? 0;
  const existingAssetIds = new Set((items ?? []).map((i) => i.assetId).filter((x): x is string => !!x));

  const expiry = expiryMeta(link.expires_at);

  function handleCopy() {
    void navigator.clipboard.writeText(link.url);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  }

  async function handleRevoke() {
    setRevoking(true);
    try {
      await fetch(`/api/projects/${projectId}/delivery/${link.token}`, { method: 'DELETE' });
      onRevoked(link.token);
    } finally {
      setRevoking(false);
      setConfirmRevoke(false);
    }
  }

  async function handleSaveEdit() {
    setEditSaving(true);
    try {
      await fetch(`/api/projects/${projectId}/delivery/${link.token}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ label: editLabel.trim() || null }),
      });
      onUpdated(link.token, { label: editLabel.trim() || null });
      setEditing(false);
    } finally {
      setEditSaving(false);
    }
  }

  const displayName = link.label || link.project_name;

  return (
    <div className="sh-card">
      <div className="sh-card-header">
        <div className="sh-card-info">
          {editing ? (
            <div className="dlp-edit-row">
              <input
                className="sh-card-name-input"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                placeholder="Label (optional)"
                maxLength={120}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveEdit();
                  if (e.key === 'Escape') { setEditing(false); setEditLabel(link.label ?? ''); }
                }}
              />
              <button
                type="button"
                className="sh-btn sh-btn--primary"
                style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                disabled={editSaving}
                onClick={() => void handleSaveEdit()}
              >
                {editSaving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="sh-btn"
                style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                onClick={() => { setEditing(false); setEditLabel(link.label ?? ''); }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <span
              className="sh-card-name sh-card-name--editable"
              title={displayName}
              onClick={() => setEditing(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setEditing(true); }}
            >
              {displayName}
              <svg className="sh-card-edit-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </span>
          )}
          <span className="sh-card-meta">
            {link.client_name && `${link.client_name} · `}
            {link.asset_count} file{link.asset_count !== 1 ? 's' : ''}{' '}
            · {link.access_count} download{link.access_count !== 1 ? 's' : ''}
            {' · '}
            <span className={expiry.cls}>{expiry.label}</span>
          </span>
        </div>

        <div className="sh-card-actions">
          <button
            type="button"
            className="sh-card-action-btn"
            title={expanded ? 'Hide videos' : 'Show videos'}
            aria-expanded={expanded}
            onClick={toggleExpanded}
          >
            {staleCount > 0 && <span className="dlp-stale-dot" title={`${staleCount} newer version${staleCount !== 1 ? 's' : ''} available`} />}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <button
            type="button"
            className="sh-card-action-btn sh-card-action-btn--accent"
            title="Copy delivery link"
            onClick={handleCopy}
          >
            {copied ? '✓' : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
            )}
          </button>

          {confirmRevoke ? (
            <>
              <button
                type="button"
                className="sh-card-action-btn sh-card-action-btn--danger"
                onClick={() => void handleRevoke()}
                disabled={revoking}
                title="Confirm revoke"
              >
                {revoking ? '…' : 'Revoke'}
              </button>
              <button
                type="button"
                className="sh-card-action-btn"
                onClick={() => setConfirmRevoke(false)}
                title="Cancel"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="sh-card-action-btn"
              title="Revoke link"
              onClick={() => setConfirmRevoke(true)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* URL row */}
      <div className="sh-card-url-row">
        <span className="sh-card-url">{link.url}</span>
      </div>

      {/* Expandable: videos + add / refresh */}
      {expanded && (
        <div className="dlp-items">
          {itemsLoading && <p className="sh-empty" style={{ padding: '6px 0' }}>Loading videos…</p>}
          {itemsError   && <p className="sh-error">{itemsError}</p>}

          {!itemsLoading && !itemsError && items && (
            <>
              {items.length === 0 && <p className="sh-empty" style={{ padding: '6px 0' }}>No videos on this link.</p>}
              {items.map((it) => (
                <div key={it.id} className="dlp-item-row">
                  <span className="dlp-item-name" title={it.filename}>{it.filename}</span>
                  {it.isStale ? (
                    <span className="dlp-item-badge dlp-item-badge--stale" title={it.missingLocalFile ? 'A newer version exists but its file is not on disk' : 'A newer version is available'}>
                      v{it.deliveredVersion} → v{it.currentVersion}{it.missingLocalFile ? ' (offline)' : ''}
                    </span>
                  ) : it.deliveredVersion != null ? (
                    <span className="dlp-item-badge">v{it.deliveredVersion}</span>
                  ) : null}
                  <span className="dlp-item-size">{formatBytes(it.fileSize)}</span>
                </div>
              ))}

              <div className="dlp-item-actions">
                <button
                  type="button"
                  className="sh-btn"
                  style={{ fontSize: '0.75rem', padding: '5px 10px' }}
                  onClick={() => setShowAdd(true)}
                >
                  + Add videos
                </button>
                <button
                  type="button"
                  className="sh-btn sh-btn--primary"
                  style={{ fontSize: '0.75rem', padding: '5px 10px' }}
                  disabled={refreshing || refreshableCount === 0}
                  title={
                    staleCount === 0 ? 'All videos are the latest version'
                    : refreshableCount === 0 ? 'Newer versions exist but their files are not on disk'
                    : 'Rebuild stale videos from their latest version'
                  }
                  onClick={() => void handleRefresh()}
                >
                  {refreshing ? 'Refreshing…' : refreshableCount > 0 ? `Refresh to latest (${refreshableCount})` : 'Refresh to latest'}
                </button>
              </div>

              {notice && <p className="dlp-item-notice">{notice}</p>}
            </>
          )}
        </div>
      )}

      {showAdd && (
        <AddVideosModal
          projectId={projectId}
          token={link.token}
          assets={assets}
          existingAssetIds={existingAssetIds}
          onClose={() => setShowAdd(false)}
          onQueued={() => {
            setNotice('Videos queued — watch the upload tray. They’ll appear on the link when ready.');
            onRefetch();
          }}
        />
      )}
    </div>
  );
}

// ── DeliveryPanelBody — shell-less content for embedding in DeliverablesHub ──

interface BodyProps {
  projectId:     string;
  assets:        MediaAsset[];
  /** True when this body is currently the visible tab — gates the fetch */
  active:        boolean;
  pendingCreate: MediaAsset[] | null;
  onPendingConsumed: () => void;
}

export function DeliveryPanelBody({
  projectId,
  assets,
  active,
  pendingCreate,
  onPendingConsumed,
}: Readonly<BodyProps>) {
  const [links,       setLinks]       = useState<DeliveryLink[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [showCreate,  setShowCreate]  = useState(false);
  const [createPreselected, setCreatePreselected] = useState<MediaAsset[]>([]);

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/delivery`);
      const data = await res.json() as { links?: DeliveryLink[]; error?: string };
      if (!res.ok) { setError(data.error ?? 'Failed to load delivery links'); return; }
      setLinks(data.links ?? []);
    } catch {
      setError('Network error — could not load delivery links');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (active) void fetchLinks();
  }, [active, fetchLinks]);

  // When pendingCreate is set, open the create modal with those assets pre-selected
  useEffect(() => {
    if (pendingCreate !== null && active) {
      setCreatePreselected(pendingCreate);
      setShowCreate(true);
      onPendingConsumed();
    }
  }, [pendingCreate, active, onPendingConsumed]);

  function handleRevoked(token: string) {
    setLinks((prev) => prev.filter((l) => l.token !== token));
  }

  function handleUpdated(token: string, patch: Partial<DeliveryLink>) {
    setLinks((prev) => prev.map((l) => l.token === token ? { ...l, ...patch } : l));
  }

  function openCreate() {
    setCreatePreselected([]);
    setShowCreate(true);
  }

  return (
    <>
      <div className="sh-panel-body">
        <button
          type="button"
          className="sh-btn sh-btn--primary sh-new-btn"
          onClick={openCreate}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New delivery
        </button>

        {loading && <p className="sh-empty">Loading…</p>}
        {error   && <p className="sh-error">{error}</p>}

        {!loading && !error && links.length === 0 && (
          <p className="sh-empty">No delivery links yet. Select files and create one to send a download page to your client.</p>
        )}

        {links.length > 0 && (
          <div className="sh-list">
            {links.map((l) => (
              <DeliveryLinkCard
                key={l.token}
                link={l}
                projectId={projectId}
                assets={assets}
                onRevoked={handleRevoked}
                onUpdated={handleUpdated}
                onRefetch={() => void fetchLinks()}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateDeliveryModal
          projectId={projectId}
          assets={assets}
          preselected={createPreselected}
          onClose={() => setShowCreate(false)}
        />
      )}
    </>
  );
}

// ── Shared helper (duplicated from MediaTab to avoid circular import) ──────────

function formatBytes(b: number): string {
  if (b < 1024)        return `${b} B`;
  if (b < 1024 ** 2)   return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3)   return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
