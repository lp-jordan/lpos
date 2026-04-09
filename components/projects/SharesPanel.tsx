'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { FrameIOShare } from '@/lib/services/frameio';
import type { MediaAsset } from '@/lib/models/media-asset';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ShareFile {
  id:       string;
  name:     string;
  lposName: string | null;
}

interface ShareWithFiles extends FrameIOShare {
  files:        ShareFile[] | null;
  filesLoading: boolean;
  expanded:     boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

// ── New Share Modal ───────────────────────────────────────────────────────────

function NewShareModal({
  projectId,
  assets,
  onClose,
  onCreated,
}: {
  projectId: string;
  assets:    MediaAsset[];
  onClose:   () => void;
  onCreated: (share: FrameIOShare) => void;
}) {
  const [name,            setName]            = useState('');
  const [selected,        setSelected]        = useState<Set<string>>(new Set());
  const [creating,        setCreating]        = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [dlEnabled, setDlEnabled] = useState(true);

  const uploadedAssets = assets.filter((a) => a.frameio.assetId);

  function toggle(assetId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/shares`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          assetIds:            [...selected],
          name:                name.trim() || undefined,
          downloading_enabled: dlEnabled,
        }),
      });
      const data = await res.json() as { share?: FrameIOShare; error?: string };
      if (!res.ok) { setError(data.error ?? 'Failed to create share'); return; }
      if (data.share) onCreated(data.share);
    } catch {
      setError('Network error — could not create share');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="sh-modal-backdrop" onClick={onClose} aria-hidden="true">
      <div className="sh-modal" role="dialog" aria-label="New share" onClick={(e) => e.stopPropagation()}>
        <div className="sh-modal-header">
          <span>New Frame.io Share</span>
          <button type="button" className="sh-modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="sh-modal-body">
          <div className="sh-modal-field">
            <label className="sh-modal-label">Share name (optional)</label>
            <input
              className="sh-modal-input"
              type="text"
              placeholder="e.g. Round 2 — Client Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
              autoFocus
            />
          </div>

          <div className="sh-modal-field">
            <label className="sh-modal-label">
              Assets to include
              {uploadedAssets.length === 0 && (
                <span className="sh-modal-hint"> — no assets uploaded to Frame.io yet</span>
              )}
            </label>
            {uploadedAssets.length > 0 && (
              <div className="sh-modal-asset-list">
                {uploadedAssets.map((a) => (
                  <label key={a.assetId} className="sh-modal-asset-row">
                    <input type="checkbox" checked={selected.has(a.assetId)} onChange={() => toggle(a.assetId)} />
                    <span>{a.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="sh-modal-field">
            <label className="sh-modal-label">Settings</label>
            <div className="sh-modal-toggles">
              <label className="sh-setting-toggle" title="Allow viewers to download files">
                <input type="checkbox" className="sh-toggle-input" checked={dlEnabled} onChange={(e) => setDlEnabled(e.target.checked)} />
                <span className="sh-toggle" /><span className="sh-setting-label">Downloads</span>
              </label>
            </div>
          </div>

          {error && <p className="sh-error">{error}</p>}
        </div>

        <div className="sh-modal-footer">
          <button type="button" className="sh-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="sh-btn sh-btn--primary"
            onClick={() => void handleCreate()}
            disabled={creating || uploadedAssets.length === 0}
          >
            {creating ? 'Creating…' : 'Create share'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Add Assets Modal ──────────────────────────────────────────────────────────

function AddAssetsModal({
  projectId,
  shareId,
  assets,
  existingFileIds,
  onClose,
  onAdded,
}: {
  projectId:       string;
  shareId:         string;
  assets:          MediaAsset[];
  existingFileIds: Set<string>;
  onClose:         () => void;
  onAdded:         () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding,   setAdding]   = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const available = assets.filter(
    (a) => a.frameio.assetId && !existingFileIds.has(a.frameio.assetId),
  );

  function toggle(assetId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }

  async function handleAdd() {
    if (!selected.size) return;
    setAdding(true);
    setError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/shares/${shareId}/files`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ assetIds: [...selected] }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? 'Failed to add assets'); return; }
      onAdded();
    } catch {
      setError('Network error — could not add assets');
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="sh-modal-backdrop" onClick={onClose} aria-hidden="true">
      <div className="sh-modal" role="dialog" aria-label="Add assets" onClick={(e) => e.stopPropagation()}>
        <div className="sh-modal-header">
          <span>Add assets to share</span>
          <button type="button" className="sh-modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="sh-modal-body">
          {available.length === 0 ? (
            <p className="sh-empty">All uploaded assets are already in this share.</p>
          ) : (
            <div className="sh-modal-asset-list">
              {available.map((a) => (
                <label key={a.assetId} className="sh-modal-asset-row">
                  <input type="checkbox" checked={selected.has(a.assetId)} onChange={() => toggle(a.assetId)} />
                  <span>{a.name}</span>
                </label>
              ))}
            </div>
          )}
          {error && <p className="sh-error">{error}</p>}
        </div>
        <div className="sh-modal-footer">
          <button type="button" className="sh-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="sh-btn sh-btn--primary"
            onClick={() => void handleAdd()}
            disabled={adding || !selected.size}
          >
            {adding ? 'Adding…' : `Add ${selected.size > 0 ? selected.size : ''} asset${selected.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Share card ────────────────────────────────────────────────────────────────

function ShareCard({
  share,
  projectId,
  assets,
  onToggleExpand,
  onDeleted,
  onFilesChanged,
}: {
  share:          ShareWithFiles;
  projectId:      string;
  assets:         MediaAsset[];
  onToggleExpand: (id: string) => void;
  onDeleted:      (id: string) => void;
  onFilesChanged: (id: string) => void;
}) {
  const [copied,            setCopied]            = useState(false);
  const [deleting,          setDeleting]          = useState(false);
  const [removingId,        setRemovingId]        = useState<string | null>(null);
  const [showAddModal,      setShowAddModal]      = useState(false);
  const [editingName,       setEditingName]       = useState(false);
  const [nameDraft,         setNameDraft]         = useState(share.name);
  const [renaming,          setRenaming]          = useState(false);
  const [downloadEnabled, setDownloadEnabled] = useState<boolean | null>(share.downloading_enabled);
  const [togglingField,   setTogglingField]   = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  async function handleToggle(value: boolean) {
    setTogglingField('downloading_enabled');
    try {
      const res = await fetch(`/api/projects/${projectId}/shares/${share.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ downloading_enabled: value }),
      });
      if (res.ok) setDownloadEnabled(value);
    } catch { /* network error — toggle reverts */ }
    finally { setTogglingField(null); }
  }

  function handleCopy() {
    navigator.clipboard.writeText(share.shareUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleDelete() {
    if (!confirm(`Delete "${share.name}"? The link will stop working.`)) return;
    setDeleting(true);
    try {
      await fetch(`/api/projects/${projectId}/shares/${share.id}`, { method: 'DELETE' });
      onDeleted(share.id);
    } catch { /* ignore */ } finally { setDeleting(false); }
  }

  async function handleRemoveFile(fileId: string) {
    setRemovingId(fileId);
    try {
      await fetch(`/api/projects/${projectId}/shares/${share.id}/files/${fileId}`, { method: 'DELETE' });
      onFilesChanged(share.id);
    } catch { /* ignore */ } finally { setRemovingId(null); }
  }

  function startEditing() {
    setNameDraft(share.name);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 0);
  }

  function cancelEditing() {
    setEditingName(false);
    setNameDraft(share.name);
  }

  async function commitRename() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === share.name) { cancelEditing(); return; }
    setRenaming(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shares/${share.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: trimmed }),
      });
      if (res.ok) {
        share.name = trimmed; // optimistic local update
      }
    } catch { /* ignore */ } finally {
      setRenaming(false);
      setEditingName(false);
    }
  }

  const existingFileIds = new Set((share.files ?? []).map((f) => f.id));
  // Prefer the live count from expanded files; fall back to the eager count from the list response.
  const count = share.files !== null ? share.files.length : share.fileCount;
  const fileCountLabel = count === null
    ? (share.filesLoading ? 'Loading…' : null)
    : `${count} file${count !== 1 ? 's' : ''}`;

  return (
    <>
      <div className={`sh-card${share.expanded ? ' sh-card--expanded' : ''}`}>
        {/* Header */}
        <div className="sh-card-header">
          <button
            type="button"
            className="sh-card-expand-btn"
            onClick={() => onToggleExpand(share.id)}
          >
            <svg
              className={`sh-chevron${share.expanded ? ' sh-chevron--open' : ''}`}
              width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5"
            >
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>

          <div className="sh-card-info">
            {editingName ? (
              <input
                ref={nameInputRef}
                className="sh-card-name-input"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')  { e.preventDefault(); void commitRename(); }
                  if (e.key === 'Escape') { e.preventDefault(); cancelEditing(); }
                }}
                onBlur={() => void commitRename()}
                disabled={renaming}
              />
            ) : (
              <button
                type="button"
                className="sh-card-name sh-card-name--editable"
                onClick={startEditing}
                title="Click to rename"
              >
                {share.name}
                <svg className="sh-card-edit-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
            )}
            <span className="sh-card-meta">
              {[share.createdAt ? formatDate(share.createdAt) : null, fileCountLabel]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>

          <div className="sh-card-actions">
            <a
              href={share.shareUrl}
              target="_blank"
              rel="noreferrer"
              className="sh-card-action-btn"
              title="Open in Frame.io"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
            <button
              type="button"
              className={`sh-card-action-btn${copied ? ' sh-card-action-btn--success' : ' sh-card-action-btn--accent'}`}
              onClick={handleCopy}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              {copied ? '✓' : 'Copy'}
            </button>
            <button
              type="button"
              className="sh-card-action-btn sh-card-action-btn--danger"
              onClick={() => void handleDelete()}
              disabled={deleting}
              aria-label="Delete share"
              title="Delete share"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
              </svg>
            </button>
          </div>
        </div>

        {/* URL row */}
        <div className="sh-card-url-row">
          <span className="sh-card-url">{share.shareUrl}</span>
        </div>

        {/* Settings toggles — visible when expanded */}
        {share.expanded && (
          <div className="sh-card-settings">
            <label className="sh-setting-toggle" title="Allow viewers to download files">
              <input
                type="checkbox"
                className="sh-toggle-input"
                checked={downloadEnabled ?? true}
                disabled={togglingField === 'downloading_enabled'}
                onChange={(e) => void handleToggle(e.target.checked)}
              />
              <span className="sh-toggle" />
              <span className="sh-setting-label">Downloads</span>
            </label>
          </div>
        )}

        {/* Expanded file list */}
        {share.expanded && (
          <div className="sh-card-files">
            {share.filesLoading && <p className="sh-empty">Loading files…</p>}

            {!share.filesLoading && share.files !== null && share.files.length === 0 && (
              <p className="sh-empty">No files in this share yet.</p>
            )}

            {share.files && share.files.length > 0 && (
              <div className="sh-file-list">
                {share.files.map((f) => (
                  <div key={f.id} className="sh-file-row">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <polygon points="10 11 16 14 10 17 10 11"/>
                    </svg>
                    <span className="sh-file-name">{f.lposName ?? f.name}</span>
                    {f.lposName && f.lposName !== f.name && (
                      <span className="sh-file-original">{f.name}</span>
                    )}
                    <button
                      type="button"
                      className="sh-file-remove-btn"
                      onClick={() => void handleRemoveFile(f.id)}
                      disabled={removingId === f.id}
                      title="Remove from share"
                      aria-label="Remove from share"
                    >
                      {removingId === f.id ? '…' : '✕'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              className="sh-add-assets-btn"
              onClick={() => setShowAddModal(true)}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add assets
            </button>
          </div>
        )}
      </div>

      {showAddModal && (
        <AddAssetsModal
          projectId={projectId}
          shareId={share.id}
          assets={assets}
          existingFileIds={existingFileIds}
          onClose={() => setShowAddModal(false)}
          onAdded={() => { setShowAddModal(false); onFilesChanged(share.id); }}
        />
      )}
    </>
  );
}

// ── SharesPanel ───────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  assets:    MediaAsset[];
  open:      boolean;
  onClose:   () => void;
}

export function SharesPanel({ projectId, assets, open, onClose }: Readonly<Props>) {
  const [shares,       setShares]       = useState<ShareWithFiles[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);

  const fetchShares = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/shares`);
      const data = await res.json() as { shares?: FrameIOShare[]; error?: string };
      if (!res.ok) { setError(data.error ?? 'Failed to load shares'); return; }
      setShares((data.shares ?? []).map((s) => ({
        ...s,
        files:        null,
        filesLoading: false,
        expanded:     false,
      })));
    } catch {
      setError('Network error — could not load shares');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Load shares when panel opens
  useEffect(() => {
    if (open) void fetchShares();
  }, [open, fetchShares]);

  const loadShareFiles = useCallback(async (shareId: string) => {
    setShares((prev) => prev.map((s) =>
      s.id === shareId ? { ...s, filesLoading: true } : s,
    ));
    try {
      const res  = await fetch(`/api/projects/${projectId}/shares/${shareId}`);
      const data = await res.json() as { files?: ShareFile[] };
      setShares((prev) => prev.map((s) =>
        s.id === shareId ? { ...s, files: data.files ?? [], filesLoading: false } : s,
      ));
    } catch {
      setShares((prev) => prev.map((s) =>
        s.id === shareId ? { ...s, filesLoading: false } : s,
      ));
    }
  }, [projectId]);

  function handleToggleExpand(shareId: string) {
    setShares((prev) => prev.map((s) => {
      if (s.id !== shareId) return s;
      const next = !s.expanded;
      if (next && s.files === null) void loadShareFiles(shareId);
      return { ...s, expanded: next };
    }));
  }

  function handleShareDeleted(shareId: string) {
    setShares((prev) => prev.filter((s) => s.id !== shareId));
  }

  function handleFilesChanged(shareId: string) {
    void loadShareFiles(shareId);
  }

  function handleShareCreated(share: FrameIOShare) {
    // Add with null files so count shows correctly while loading
    setShares((prev) => [
      { ...share, files: null, filesLoading: false, expanded: true },
      ...prev,
    ]);
    setShowNewModal(false);
    // Immediately load the files so the count reflects what was just created
    void loadShareFiles(share.id);
  }

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div className="sh-backdrop" onClick={onClose} aria-hidden="true" />
      )}

      {/* Panel */}
      <aside className={`sh-panel${open ? ' sh-panel--open' : ''}`} role="dialog" aria-label="Share links">
        {/* Header */}
        <div className="sh-panel-header">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          <span className="sh-panel-title">Share Links</span>
          <div className="sh-panel-header-actions">
            <button
              type="button"
              className="sh-icon-btn"
              onClick={() => void fetchShares()}
              title="Refresh"
              aria-label="Refresh shares"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
            </button>
            <button
              type="button"
              className="sh-icon-btn"
              onClick={onClose}
              aria-label="Close shares panel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="sh-panel-body">
          {/* New share button */}
          <button
            type="button"
            className="sh-btn sh-btn--primary sh-new-btn"
            onClick={() => setShowNewModal(true)}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New share
          </button>

          {loading && <p className="sh-empty">Loading shares…</p>}
          {error   && <p className="sh-error">{error}</p>}

          {!loading && !error && shares.length === 0 && (
            <p className="sh-empty">No shares yet. Create one to send a review link to your client.</p>
          )}

          {shares.length > 0 && (
            <div className="sh-list">
              {shares.map((s) => (
                <ShareCard
                  key={s.id}
                  share={s}
                  projectId={projectId}
                  assets={assets}
                  onToggleExpand={handleToggleExpand}
                  onDeleted={handleShareDeleted}
                  onFilesChanged={handleFilesChanged}
                />
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* New share modal — rendered outside the panel so it stacks above it */}
      {showNewModal && (
        <NewShareModal
          projectId={projectId}
          assets={assets}
          onClose={() => setShowNewModal(false)}
          onCreated={handleShareCreated}
        />
      )}
    </>
  );
}
