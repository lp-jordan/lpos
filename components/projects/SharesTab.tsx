'use client';

import { useState, useEffect, useCallback } from 'react';
import type { FrameIOShare } from '@/lib/services/frameio';
import type { MediaAsset } from '@/lib/models/media-asset';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ShareFile {
  id:       string;   // Frame.io file ID
  name:     string;   // Frame.io filename
  lposName: string | null;  // LPOS display name if matched
}

interface ShareWithFiles extends FrameIOShare {
  files:        ShareFile[] | null;  // null = not yet loaded
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
  const [name,       setName]       = useState('');
  const [selected,   setSelected]   = useState<Set<string>>(new Set());
  const [creating,   setCreating]   = useState(false);
  const [error,      setError]      = useState<string | null>(null);

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
        body:    JSON.stringify({ assetIds: [...selected], name: name.trim() || undefined }),
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
              placeholder="e.g. Review Round 2 — Client Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="sh-modal-field">
            <label className="sh-modal-label">
              Assets to include
              {uploadedAssets.length === 0 && (
                <span className="sh-modal-hint"> — No assets uploaded to Frame.io yet</span>
              )}
            </label>
            {uploadedAssets.length > 0 && (
              <div className="sh-modal-asset-list">
                {uploadedAssets.map((a) => (
                  <label key={a.assetId} className="sh-modal-asset-row">
                    <input
                      type="checkbox"
                      checked={selected.has(a.assetId)}
                      onChange={() => toggle(a.assetId)}
                    />
                    <span>{a.name}</span>
                  </label>
                ))}
              </div>
            )}
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

  // Exclude assets already in the share
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
      <div className="sh-modal" role="dialog" aria-label="Add assets to share" onClick={(e) => e.stopPropagation()}>
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
                  <input
                    type="checkbox"
                    checked={selected.has(a.assetId)}
                    onChange={() => toggle(a.assetId)}
                  />
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
  share:           ShareWithFiles;
  projectId:       string;
  assets:          MediaAsset[];
  onToggleExpand:  (shareId: string) => void;
  onDeleted:       (shareId: string) => void;
  onFilesChanged:  (shareId: string) => void;
}) {
  const [copied,       setCopied]       = useState(false);
  const [deleting,     setDeleting]     = useState(false);
  const [removingId,   setRemovingId]   = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(share.shareUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleDelete() {
    if (!confirm(`Delete share "${share.name}"? The link will stop working.`)) return;
    setDeleting(true);
    try {
      await fetch(`/api/projects/${projectId}/shares/${share.id}`, { method: 'DELETE' });
      onDeleted(share.id);
    } catch { /* ignore */ } finally {
      setDeleting(false);
    }
  }

  async function handleRemoveFile(fileId: string) {
    setRemovingId(fileId);
    try {
      await fetch(`/api/projects/${projectId}/shares/${share.id}/files/${fileId}`, { method: 'DELETE' });
      onFilesChanged(share.id);
    } catch { /* ignore */ } finally {
      setRemovingId(null);
    }
  }

  const existingFileIds = new Set((share.files ?? []).map((f) => f.id));

  return (
    <>
      <div className={`sh-card${share.expanded ? ' sh-card--expanded' : ''}`}>
        {/* Card header */}
        <div className="sh-card-header">
          <button
            type="button"
            className="sh-card-expand-btn"
            onClick={() => onToggleExpand(share.id)}
            aria-label={share.expanded ? 'Collapse' : 'Expand'}
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
            <span className="sh-card-name">{share.name}</span>
            <span className="sh-card-meta">
              {share.createdAt ? formatDate(share.createdAt) : ''}
              {share.files !== null && ` · ${share.files.length} file${share.files.length !== 1 ? 's' : ''}`}
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
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
            <button
              type="button"
              className="sh-card-action-btn sh-card-action-btn--accent"
              onClick={handleCopy}
              title="Copy share link"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              {copied ? '✓ Copied' : 'Copy link'}
            </button>
            <button
              type="button"
              className="sh-card-action-btn sh-card-action-btn--danger"
              onClick={() => void handleDelete()}
              disabled={deleting}
              title="Delete share"
              aria-label="Delete share"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

        {/* Expanded: file list */}
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
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
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

// ── Main SharesTab ────────────────────────────────────────────────────────────

export function SharesTab({ projectId }: { projectId: string }) {
  const [shares,       setShares]       = useState<ShareWithFiles[]>([]);
  const [assets,       setAssets]       = useState<MediaAsset[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);

  const fetchShares = useCallback(async () => {
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

  useEffect(() => { void fetchShares(); }, [fetchShares]);

  // Also load LPOS assets for the add-assets picker
  useEffect(() => {
    fetch(`/api/projects/${projectId}/media`)
      .then((r) => r.json() as Promise<{ assets?: MediaAsset[] }>)
      .then((d) => setAssets(d.assets ?? []))
      .catch(() => {});
  }, [projectId]);

  async function loadShareFiles(shareId: string) {
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
  }

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
    // Re-fetch files for this share
    void loadShareFiles(shareId);
  }

  function handleShareCreated(share: FrameIOShare) {
    setShares((prev) => [
      { ...share, files: [], filesLoading: false, expanded: true },
      ...prev,
    ]);
    setShowNewModal(false);
  }

  return (
    <div className="proj-tab-content page-stack">
      {/* Toolbar */}
      <div className="sh-toolbar">
        <button
          type="button"
          className="sh-btn sh-btn--primary"
          onClick={() => setShowNewModal(true)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New share
        </button>
        <button
          type="button"
          className="sh-icon-btn"
          onClick={() => void fetchShares()}
          title="Refresh"
          aria-label="Refresh shares"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
      </div>

      {/* States */}
      {loading && <p className="m-empty">Loading shares…</p>}
      {error   && <p className="sh-error">{error}</p>}

      {!loading && !error && shares.length === 0 && (
        <p className="m-empty">
          No shares yet. Create one to send a review link to your client.
        </p>
      )}

      {/* Share list */}
      {!loading && shares.length > 0 && (
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

      {/* New share modal */}
      {showNewModal && (
        <NewShareModal
          projectId={projectId}
          assets={assets}
          onClose={() => setShowNewModal(false)}
          onCreated={handleShareCreated}
        />
      )}
    </div>
  );
}
